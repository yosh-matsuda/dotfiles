// Denies an `ask_user` that asks several things at once with no explanation the user can read.
// `copilot-instructions.md` puts the explanation in the text of the same response as the call,
// but after a long run of tool calls the model asks with terms that only its own context holds:
// a plan file it wrote, the report of a subagent, or the summary of a compaction. The user sees a
// form such as 「計画について 3 点を決めてほしい」 and cannot tell what it asks. Run on `preToolUse`
// with `matcher: "ask_user"`.
//
// A question with one field is mostly a confirmation, such as 「push してよいか」, and is left alone.
// The check denies once per turn, so a question that must stay short costs one retry at most.
//
// Every failure exits 0 with no output. `preToolUse` denies the tool on a crash, and a broken
// check must never block `ask_user`.
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_EXPLANATION_LETTERS = 40;
const MIN_MESSAGE_LETTERS = 80;
const MIN_FIELDS = 2;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const RETRY_ATTEMPTS = 8;
const RETRY_INTERVAL_MS = 250;
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[`~]*[ \t]*$/gm;
const DENY_MARK = "ask_user の前に説明が無かった。";

const letters = (text) => ((text ?? "").replace(FENCED_CODE, "").match(/\p{L}/gu) || []).length;

function parse(value) {
    if (typeof value !== "string") {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

// `explanation` is the text of the response that calls `ask_user`, and `args` its arguments.
export function lacksExplanation(explanation, args) {
    const schema = parse(args?.requestedSchema) ?? {};
    const fields = Object.keys(schema.properties ?? {}).length;
    return fields >= MIN_FIELDS
        && letters(explanation) < MIN_EXPLANATION_LETTERS
        && letters(args?.message) < MIN_MESSAGE_LETTERS;
}

// The last top-level assistant message of the turn with a tool call that has not completed, and
// whether this hook already denied a question in the turn.
function readTurn(transcriptPath) {
    const fd = openSync(transcriptPath, "r");
    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
        const buffer = Buffer.alloc(size - start);
        readSync(fd, buffer, 0, buffer.length, start);
        const lines = buffer.toString("utf8").split("\n");
        if (start > 0) {
            lines.shift();
        }
        const completed = new Set();
        let message;
        let denied = false;
        for (const line of lines.reverse()) {
            if (!line.includes('"assistant.message"') && !line.includes('"user.message"')
                && !line.includes('"tool.execution_complete"')) {
                continue;
            }
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                continue;
            }
            const data = event.data ?? {};
            if (event.type === "tool.execution_complete") {
                completed.add(data.toolCallId);
                denied ||= String(data.error?.message ?? "").includes(DENY_MARK);
                continue;
            }
            // A subagent writes its messages into the same transcript and marks them with its id.
            if (event.agentId || data.parentToolCallId) {
                continue;
            }
            if (event.type === "user.message") {
                break;
            }
            if (event.type === "assistant.message" && !message) {
                const pending = (data.toolRequests ?? [])
                    .filter((request) => !completed.has(request?.toolCallId));
                if (pending.length === 0) {
                    return { message: undefined, denied };
                }
                message = {
                    text: typeof data.content === "string" ? data.content : "",
                    pending: pending.map((request) => request?.name),
                };
            }
        }
        return { message, denied };
    } finally {
        closeSync(fd);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function field(input, ...keys) {
    for (const key of keys) {
        if (input[key] !== undefined && input[key] !== null) {
            return input[key];
        }
    }
    return undefined;
}

async function onAsk(input) {
    const sessionId = field(input, "sessionId", "session_id");
    if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) {
        return undefined;
    }
    const args = parse(field(input, "toolArgs", "tool_input")) ?? {};
    if (!lacksExplanation("", args)) {
        return undefined;
    }
    const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
    const transcript = join(home, "session-state", sessionId, "events.jsonl");
    // The CLI may write the message into the transcript after the hook starts.
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        const { message, denied } = readTurn(transcript);
        // A subagent reports its parent's session id, and its calls are not in the parent's message.
        if (message?.pending.includes("ask_user")) {
            if (denied || !lacksExplanation(message.text, args)) {
                return undefined;
            }
            return {
                permissionDecision: "deny",
                permissionDecisionReason: DENY_MARK + "質問はまだ表示していない。ユーザーは、自分が書いた"
                    + "ファイル（plan.md など）、サブエージェントの報告、ツールの出力、compaction の要約を"
                    + "読んでいない。ask_user を呼ぶ応答の本文に、項目ごとに何を決めるのか、そこに至った"
                    + "事情、選択肢で何が変わるのか、推奨する選択肢とその理由を書く。そのうえで同じ応答で"
                    + "ask_user をもう一度呼ぶ。項目の title には、本文で説明した言葉を使う。",
            };
        }
        await sleep(RETRY_INTERVAL_MS);
    }
    return undefined;
}

async function main() {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const output = await onAsk(input);
    if (output) {
        process.stdout.write(JSON.stringify(output));
    }
}

// `~/.copilot/hooks` is a symlink, and `import.meta.url` gives the resolved path.
const isEntryPoint = () => {
    try {
        return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
};

if (process.argv[1] && isEntryPoint()) {
    main().catch(() => {}).finally(() => process.exit(0));
}
