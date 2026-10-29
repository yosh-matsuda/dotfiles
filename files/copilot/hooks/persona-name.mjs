// Keeps the persona from opening a message with its own name, as in 「ずんだもん、〜するのだ」 or
// 「ずんだもんが〜するのだ」. `souls/common/persona.instructions.md` forbids it, but a model that does
// it once in a session copies the form into every following progress message. Run as
// `node persona-name.mjs tool|stop`.
//
// `tool` runs on `preToolUse` and checks the message that requested the tool. `stop` runs on
// `agentStop` and checks the reply that ended the turn. The persona is the directory that
// `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` points at.
//
// Every failure exits 0 with no output. `preToolUse` denies the tool on a crash, and a broken
// check must never block the work.
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const RETRY_ATTEMPTS = 8;
const RETRY_INTERVAL_MS = 250;
const FRESH_WINDOW_MS = 5000;

// The longer form comes first, because the shorter one is its suffix or prefix.
const SELF_NAMES = {
    zundamon: ["ずんだもん"],
    metan: ["四国めたん", "めたん"],
    tsumugi: ["春日部つむぎ", "つむぎ"],
    akane: ["琴葉茜", "茜"],
    aoi: ["琴葉葵", "葵"],
    kiritan: ["東北きりたん", "きりたん"],
    yukari: ["結月ゆかり", "ゆかり"],
    reimu: ["ゆっくり霊夢", "霊夢"],
    marisa: ["ゆっくり魔理沙", "魔理沙"],
    yousei: ["妖精さん", "ようせいさん"],
    sebastian: ["セバスチャン・ミカエリス", "セバスチャン"],
    secretary: ["秘書"],
    concierge: ["コンシェルジュ"],
};

// The name followed by 「、」 reads as a call, and followed by a particle it is the subject.
export function openingName(text, names) {
    const head = text.replace(/^[\s>*_#-]+/, "");
    for (const name of names) {
        if (head.startsWith(name) && /^(?:ちゃん|さん)?\s*[、,，がは]/.test(head.slice(name.length))) {
            return name;
        }
    }
    return undefined;
}

export function personaNames(dirs) {
    for (const dir of (dirs ?? "").split(",")) {
        try {
            const names = SELF_NAMES[basename(realpathSync(dir.trim()))];
            if (names) {
                return names;
            }
        } catch {
            continue;
        }
    }
    return undefined;
}

function field(input, ...keys) {
    for (const key of keys) {
        if (input[key] !== undefined && input[key] !== null) {
            return input[key];
        }
    }
    return undefined;
}

function toMillis(value) {
    if (typeof value === "number") {
        return value;
    }
    const parsed = Date.parse(value ?? "");
    return Number.isNaN(parsed) ? undefined : parsed;
}

// The last top-level assistant message of the turn, or undefined when the turn has none yet.
// `pending` names the tools it requested that have not completed, a denied call included.
function lastMessage(transcriptPath) {
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
                continue;
            }
            // A subagent writes its messages into the same transcript and marks them with its id.
            if (event.agentId || data.parentToolCallId) {
                continue;
            }
            if (event.type === "user.message") {
                return undefined;
            }
            if (event.type === "assistant.message") {
                const requests = data.toolRequests ?? [];
                return {
                    text: typeof data.content === "string" ? data.content : "",
                    requested: requests.length > 0,
                    pending: requests.filter((request) => !completed.has(request?.toolCallId))
                        .map((request) => request?.name),
                    time: toMillis(event.timestamp),
                };
            }
        }
        return undefined;
    } finally {
        closeSync(fd);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The CLI may write the message into the transcript after the hook starts, so the last message
// read can be the previous one. `isCurrent` tells the message of this event from it.
async function currentMessage(transcript, isCurrent) {
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        const message = lastMessage(transcript);
        if (message && isCurrent(message)) {
            return message;
        }
        await sleep(RETRY_INTERVAL_MS);
    }
    return undefined;
}

async function onTool(input, names) {
    const sessionId = field(input, "sessionId", "session_id");
    const toolName = field(input, "toolName", "tool_name");
    if (typeof sessionId !== "string" || !/^[\w-]+$/.test(sessionId)) {
        return undefined;
    }
    // A subagent raises the event with its own session id, which has no transcript of its own.
    const transcript = join(homedir(), ".copilot", "session-state", sessionId, "events.jsonl");
    // The tools of the previous message have all completed before the next message is written.
    const message = await currentMessage(transcript, (candidate) => candidate.pending.length > 0);
    // A pending call of another tool belongs to a subagent that reports its parent's session id.
    const name = message?.pending.includes(toolName) && openingName(message.text, names);
    if (!name) {
        return undefined;
    }
    return {
        permissionDecision: "deny",
        permissionDecisionReason: `直前のメッセージが「${name}」で始まり、persona の名前を呼びかけか主語にしていた。`
            + "ツールは実行していない。名前を使わずに、これからする動作から書くか一人称を主語にして"
            + "メッセージを書き直し、同じツールをもう一度呼ぶ。この後のメッセージも名前で始めない。",
    };
}

async function onStop(input, names) {
    if (field(input, "stop_hook_active", "stopHookActive")) {
        return undefined;
    }
    const transcript = field(input, "transcriptPath", "transcript_path");
    if (typeof transcript !== "string") {
        return undefined;
    }
    // A subagent raises the event too, with the transcript of its parent and its own session id.
    const sessionId = field(input, "sessionId", "session_id");
    if (sessionId && basename(dirname(normalize(transcript))) !== sessionId) {
        return undefined;
    }
    const stopTime = toMillis(field(input, "timestamp"));
    const message = await currentMessage(transcript, (candidate) => !candidate.requested
        && (stopTime === undefined || candidate.time === undefined
            || candidate.time >= stopTime - FRESH_WINDOW_MS));
    const name = message && openingName(message.text, names);
    if (!name) {
        return undefined;
    }
    return {
        decision: "block",
        reason: `直前の最終回答が「${name}」で始まり、persona の名前を呼びかけか主語にしていた。`
            + "名前を使わずに、答えか一人称から始めて同じ内容でもう一度回答する。ツールは呼ばない。",
    };
}

async function main() {
    const names = personaNames(process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS);
    if (!names) {
        return;
    }
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const mode = process.argv[2];
    const output = mode === "tool" ? await onTool(input, names)
        : mode === "stop" ? await onStop(input, names) : undefined;
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
