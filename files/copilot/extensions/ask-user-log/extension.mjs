import { joinSession } from "@github/copilot-sdk/extension";

// The CLI clears the form of `ask_user` once it is answered, and keeps neither the question nor
// the answer in the timeline. This extension writes both into the timeline with `session.log`,
// which also persists them, so `--resume` shows them again.

const pending = new Map();

function choicesOf(property) {
    const items = property.items ?? {};
    return [
        ...(property.oneOf ?? []),
        ...(items.anyOf ?? []),
        ...(property.enum ?? []).map((value, i) => ({ const: value, title: property.enumNames?.[i] })),
        ...(items.enum ?? []).map((value) => ({ const: value })),
    ]
        .filter((choice) => choice?.const !== undefined)
        .map((choice) => ({ value: String(choice.const), title: choice.title ?? String(choice.const) }));
}

// Every choice is listed, and the chosen ones are marked. An answer typed in place of a choice
// follows the list.
function choiceLines(choices, selected) {
    const known = new Set(choices.map((choice) => choice.value));
    return [
        ...choices.map((choice) => `  ${selected.includes(choice.value) ? "●" : "○"} ${choice.title}`),
        ...selected.filter((value) => !known.has(value)).map((value) => `  ● ${value} (free text)`),
    ];
}

function fieldLines(key, property, value) {
    const name = property.title ?? key;
    const choices = choicesOf(property);
    if (choices.length === 0) {
        const shown = property.type === "boolean"
            ? { true: "yes", false: "no" }[value] ?? value
            : value;
        return [`${name}: ${shown ?? "(no answer)"}`];
    }
    // A multi-select answer joins the values with ", ", which a single value may contain too.
    const selected = value === undefined
        ? []
        : choices.some((choice) => choice.value === value) || property.type !== "array"
            ? [value]
            : value.split(", ");
    return [name, ...choiceLines(choices, selected)];
}

// `detailedContent` holds one `key: value` line per field after "User responded:". A typed
// answer may span lines, so a line that starts no field continues the one before it.
function parseAnswers(text, properties) {
    const values = {};
    let current;
    for (const line of text.split("\n").slice(1)) {
        const separator = line.indexOf(": ");
        const key = separator < 0 ? undefined : line.slice(0, separator);
        if (key !== undefined && Object.hasOwn(properties, key) && !(key in values)) {
            current = key;
            values[key] = line.slice(separator + 2);
        } else if (current !== undefined) {
            values[current] += `\n${line}`;
        }
    }
    return values;
}

function answerLines(args, result) {
    const text = (result?.detailedContent ?? result?.content ?? "").trim();
    const properties = args.requestedSchema?.properties;
    if (properties && text.startsWith("User responded:\n")) {
        const values = parseAnswers(text, properties);
        return Object.entries(properties).flatMap(([key, property]) => fieldLines(key, property, values[key]));
    }
    // The older form of the tool takes a list of `choices` and answers "User selected: <choice>".
    const selected = text.match(/^User selected: ([\s\S]*)$/)?.[1];
    if (Array.isArray(args.choices) && selected !== undefined) {
        return choiceLines(args.choices.map((choice) => ({ value: choice, title: choice })), [selected]);
    }
    return [`→ ${text}`];
}

function format(args, result) {
    const question = (args.message ?? args.question ?? "").trim();
    return ["ask_user", question, "", ...answerLines(args, result)].join("\n");
}

const session = await joinSession({});

session.on("tool.execution_start", (event) => {
    const { toolName, toolCallId, arguments: args } = event.data;
    if (toolName === "ask_user" && args) {
        pending.set(toolCallId, args);
    }
});

session.on("tool.execution_complete", async (event) => {
    const { toolCallId, success, result } = event.data;
    const args = pending.get(toolCallId);
    if (!args) {
        return;
    }
    pending.delete(toolCallId);
    // A question that a `preToolUse` hook denied never reached the user.
    if (!success) {
        return;
    }
    try {
        await session.log(format(args, result));
    } catch {
        // A failed log must not disturb the session.
    }
});
