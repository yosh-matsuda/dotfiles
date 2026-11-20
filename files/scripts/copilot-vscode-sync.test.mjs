import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import jsonc from "jsonc-parser";
import { vscodeSettingsFromCopilot } from "./copilot-vscode-sync.mjs";
import { mergeIntoFile } from "./vscode-settings-merge.mjs";

const repo = join(import.meta.dirname, "..", "..");

test("translates the CLI values into the VS Code values", () => {
  const derived = vscodeSettingsFromCopilot({
    defaultMode: "plan",
    defaultPermissionMode: "allow-all",
    effortLevel: "high",
    includeCoAuthoredBy: false,
    model: "gpt-6.2-astra",
  });
  assert.deepEqual(derived, {
    "settings.json": {
      "chat.agentHost.copilot.includeCoAuthoredBy": false,
      "chat.defaultConfiguration": { mode: "plan", approvals: "allowAll" },
    },
    "globalStorage/agent-host-config.json": { includeCoAuthoredBy: false },
    "chatLanguageModels.json": [
      { name: "Copilot", vendor: "agent-host-copilotcli", settings: { "gpt-6.2-astra": { thinkingLevel: "high" } } },
    ],
  });
});

test("leaves the effort out for auto and for models of another provider", () => {
  for (const settings of [
    { model: "auto", effortLevel: "high" },
    { model: "Fusion", effortLevel: "high" },
    { model: "gpt-6.2-astra", modelProviderId: "byok", effortLevel: "high" },
  ]) {
    assert.deepEqual(vscodeSettingsFromCopilot(settings)["chatLanguageModels.json"], []);
  }
});

test("rejects CLI values that VS Code has no counterpart for", () => {
  assert.throws(() => vscodeSettingsFromCopilot({ defaultPermissionMode: "yolo" }), /defaultPermissionMode/);
  assert.throws(() => vscodeSettingsFromCopilot({ model: "gpt-6.2-astra", effortLevel: "extreme" }), /effortLevel/);
});

test("merges a language model entry into the entry of the same vendor only", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-vscode-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = join(dir, "chatLanguageModels.json");
  const other = `    {
        // kept as written
        "name": "fixstars",
        "vendor": "litellm",
        "apiKey": "\${input:chat.lm.secret.-1}"
    }`;
  writeFileSync(
    live,
    `[\n${other},\n    {\n        "name": "Copilot",\n        "vendor": "agent-host-copilotcli",\n        "settings": {\n            "claude-opus-5.5": {\n                "thinkingLevel": "high"\n            }\n        }\n    }\n]\n`,
  );
  const tracked = [
    { name: "Copilot", vendor: "agent-host-copilotcli", settings: { auto: { tier: "hydrafusion-max" } } },
    { name: "Copilot", vendor: "agent-host-copilotcli", settings: { "gpt-6.2-astra": { thinkingLevel: "high" } } },
  ];

  assert.equal(mergeIntoFile(tracked, live), true);
  const text = readFileSync(live, "utf8");
  assert.ok(text.includes(other));
  assert.deepEqual(jsonc.parse(text)[1].settings, {
    "claude-opus-5.5": { thinkingLevel: "high" },
    auto: { tier: "hydrafusion-max" },
    "gpt-6.2-astra": { thinkingLevel: "high" },
  });
  assert.equal(mergeIntoFile(tracked, live), false);
});

test("merges entries of one vendor into a single entry when the live file lacks it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-vscode-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tracked = [
    { name: "Copilot", vendor: "agent-host-copilotcli", settings: { auto: { tier: "hydrafusion-max" } } },
    { name: "Copilot", vendor: "agent-host-copilotcli", settings: { "gpt-6.2-astra": { thinkingLevel: "high" } } },
  ];
  const merged = [
    {
      name: "Copilot",
      vendor: "agent-host-copilotcli",
      settings: { auto: { tier: "hydrafusion-max" }, "gpt-6.2-astra": { thinkingLevel: "high" } },
    },
  ];

  for (const initial of [undefined, `[{ "name": "Copilot", "vendor": "agent-host-copilotcli" }]\n`]) {
    const live = join(dir, "chatLanguageModels.json");
    rmSync(live, { force: true });
    if (initial) writeFileSync(live, initial);
    assert.equal(mergeIntoFile(tracked, live), true);
    assert.deepEqual(jsonc.parse(readFileSync(live, "utf8")), merged);
    assert.equal(mergeIntoFile(tracked, live), false);
  }
});

test("tracked VS Code settings leave the keys derived from the CLI settings alone", () => {
  // Both merges would rewrite a shared key on every run.
  const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const leaves = (value, path) =>
    isPlainObject(value) ? Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key])) : [path.join(" > ")];
  const keys = (value) =>
    Array.isArray(value)
      ? value.flatMap(({ name, vendor, ...rest }) => leaves(rest, [vendor]))
      : Object.keys(value);

  const copilot = JSON.parse(readFileSync(join(repo, "files/copilot/settings.json"), "utf8"));
  for (const [file, derived] of Object.entries(vscodeSettingsFromCopilot(copilot))) {
    let tracked;
    try {
      tracked = jsonc.parse(readFileSync(join(repo, "files/windows/vscode", file), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const shared = keys(derived).filter((key) => keys(tracked).includes(key));
    assert.deepEqual(shared, [], `files/windows/vscode/${file}`);
  }
});
