// Keeps the replies addressed to the user in Japanese. Progress messages between tool calls may
// use any language, so only two things are checked: the reply that ends a turn (`agentStop`) and
// the question of `ask_user` (`preToolUse`). Run as `node reply-language.mjs stop|ask`.
//
// Japanese is told apart by its kana, which no other script uses. Chinese has kanji but no kana,
// so it fails the check like English, Russian or Spanish.
//
// Every failure exits 0 with no output. `preToolUse` denies the tool on a crash, and a broken
// check must never block `ask_user`.
import { closeSync, openSync, readFileSync, readSync, realpathSync, fstatSync } from "node:fs";
import { basename, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_LETTERS = 20;
const MIN_KANA_RATIO = 0.15;
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
const RETRY_ATTEMPTS = 8;
const RETRY_INTERVAL_MS = 250;
const FRESH_WINDOW_MS = 5000;
const KANA = /[\u3040-\u309f\u30a0-\u30ff]/;

function countLetters(text) {
    const prose = text
        .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[`~]*[ \t]*$/gm, "")
        .replace(/`[^`\n]*`/g, "")
        .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, (link, label) => (KANA.test(label) ? label : ""))
        .replace(/https?:\/\/\S+/g, "");
    return {
        letters: (prose.match(/\p{L}/gu) || []).length,
        kana: (prose.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length,
    };
}

export function isJapanese(text) {
    const { letters, kana } = countLetters(text);
    return letters < MIN_LETTERS || kana / letters >= MIN_KANA_RATIO;
}

// The labels of choices are mostly identifiers, so they fail only when they hold no kana at all.
function areJapaneseChoices(labels) {
    const { letters, kana } = countLetters(labels.join("\n"));
    return letters < MIN_LETTERS || kana > 0;
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

// The last reply of the turn: an assistant message that has text and requests no tool.
function lastReply(transcriptPath) {
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
        for (const line of lines.reverse()) {
            if (!line.includes('"assistant.message"') && !line.includes('"user.message"')) {
                continue;
            }
            let event;
            try {
                event = JSON.parse(line);
            } catch {
                continue;
            }
            const data = event.data ?? {};
            // A subagent writes its messages into the same transcript and marks them with its id.
            if (event.agentId || data.parentToolCallId) {
                continue;
            }
            // The turn starts at the message of the user, so a reply before it is not this turn's.
            if (event.type === "user.message") {
                return undefined;
            }
            if (event.type !== "assistant.message") {
                continue;
            }
            if ((data.toolRequests ?? []).length > 0) {
                return undefined;
            }
            if (typeof data.content === "string" && data.content.trim()) {
                return { text: data.content, time: toMillis(event.timestamp) };
            }
        }
        return undefined;
    } finally {
        closeSync(fd);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function onStop(input) {
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
    // The CLI writes the reply into the transcript after the hook starts.
    const stopTime = toMillis(field(input, "timestamp"));
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        const reply = lastReply(transcript);
        const fresh = reply && (stopTime === undefined || reply.time === undefined
            || reply.time >= stopTime - FRESH_WINDOW_MS);
        if (fresh) {
            if (isJapanese(reply.text)) {
                return undefined;
            }
            return {
                decision: "block",
                reason: "直前の最終回答は日本語ではなかった。同じ内容を日本語で書き直して、もう一度回答する。"
                    + "ツールは呼ばない。",
            };
        }
        await sleep(RETRY_INTERVAL_MS);
    }
    return undefined;
}

function onAsk(input) {
    let args = field(input, "toolArgs", "tool_input") ?? {};
    if (typeof args === "string") {
        args = JSON.parse(args);
    }
    const parts = [args.message ?? ""];
    const labels = [];
    for (const property of Object.values(args.requestedSchema?.properties ?? {})) {
        parts.push(property.title ?? "", property.description ?? "");
        // The labels of the choices are shown too. `enum` is shown only when no label replaces it.
        const choices = [
            ...(property.enumNames ?? property.enum ?? []),
            ...(property.oneOf ?? []).map((choice) => choice?.title),
            ...(property.items?.enum ?? []),
            ...(property.items?.anyOf ?? []).map((choice) => choice?.title),
        ];
        labels.push(...choices.filter((choice) => typeof choice === "string"));
    }
    if (isJapanese(parts.join("\n")) && areJapaneseChoices(labels)) {
        return undefined;
    }
    return {
        permissionDecision: "deny",
        permissionDecisionReason: "ask_user の質問が日本語ではなかった。message と各項目の title、description、"
            + "選択肢のラベルを日本語で書き直して、もう一度 ask_user を呼ぶ。",
    };
}

async function main() {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const mode = process.argv[2];
    const output = mode === "stop" ? await onStop(input) : mode === "ask" ? onAsk(input) : undefined;
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
