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

// The answer names a choice by its value (CLI 1.0.105 and older) or by its title (1.0.107 and
// newer). A multi-select answer joins them with ", ", which a single one may contain too, so the
// longest known choice is taken first and the text up to the next ", " counts as typed.
function selectedValues(choices, value, multiple) {
    const names = choices
        .flatMap((choice) => [choice.title, choice.value].map((name) => ({ name, value: choice.value })))
        .sort((a, b) => b.name.length - a.name.length);
    const whole = names.find(({ name }) => name === value);
    if (whole || !multiple) {
        return [whole?.value ?? value];
    }
    const selected = [];
    let rest = value;
    while (rest !== "") {
        const known = names.find(({ name }) => rest === name || rest.startsWith(`${name}, `));
        const length = known?.name.length ?? (rest.includes(", ") ? rest.indexOf(", ") : rest.length);
        selected.push(known?.value ?? rest.slice(0, length));
        rest = rest.slice(length + 2);
    }
    return selected;
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
    const selected = value === undefined ? [] : selectedValues(choices, value, property.type === "array");
    return [name, ...choiceLines(choices, selected)];
}

// `detailedContent` holds one line per answered field after "User responded:". The line starts
// with the key of the field (CLI 1.0.105 and older) or with its title (1.0.107 and newer), then
// ": ". A title may hold ": " or repeat another title, so the longest name of a field not yet
// answered is taken. A typed answer may span lines, so a line that starts no field continues the
// one before it.
function parseAnswers(text, properties) {
    const names = Object.entries(properties)
        .flatMap(([key, property]) => [property.title, key]
            .filter((name) => typeof name === "string" && name !== "")
            .map((name) => ({ key, name })))
        .sort((a, b) => b.name.length - a.name.length);
    const values = {};
    let current;
    for (const line of text.split("\n").slice(1)) {
        const field = names.find(({ key, name }) => !(key in values)
            && (line.startsWith(`${name}: `) || line === `${name}:`));
        if (field) {
            current = field.key;
            values[current] = line.slice(field.name.length + 2);
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
