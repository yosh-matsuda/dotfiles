#!/usr/bin/env node
// Apply the Copilot CLI settings to the VS Code settings that Copilot sessions in the VS Code
// agent host use instead of ~/.copilot/settings.json.
// Prints "changed: FILE" for each VS Code user file that was written.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mergeIntoFile } from "./vscode-settings-merge.mjs";

const MODES = { interactive: "interactive", plan: "plan", autopilot: "autopilot" };
const APPROVALS = { manual: "manual", assisted: "assisted", "allow-all": "allowAll" };
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const translate = (key, value, table) => {
  if (!Object.hasOwn(table, value)) {
    throw new Error(`${key}: VS Code has no value for ${JSON.stringify(value)}`);
  }
  return table[value];
};

const expectType = (key, value, type) => {
  if (typeof value !== type) {
    throw new Error(`${key}: expected a ${type}, got ${JSON.stringify(value)}`);
  }
  return value;
};

// Maps each VS Code user file, relative to the user directory, to the values to merge into it.
export function vscodeSettingsFromCopilot(copilot) {
  const settings = {};
  const agentHostConfig = {};
  const languageModels = [];

  if (copilot.includeCoAuthoredBy !== undefined) {
    const value = expectType("includeCoAuthoredBy", copilot.includeCoAuthoredBy, "boolean");
    settings["chat.agentHost.copilot.includeCoAuthoredBy"] = value;
    agentHostConfig.includeCoAuthoredBy = value;
  }

  // The whole object is replaced, so a CLI key left unset gives the VS Code default, which matches the CLI default.
  if (copilot.defaultMode !== undefined || copilot.defaultPermissionMode !== undefined) {
    settings["chat.defaultConfiguration"] = {
      ...(copilot.defaultMode !== undefined && { mode: translate("defaultMode", copilot.defaultMode, MODES) }),
      ...(copilot.defaultPermissionMode !== undefined && {
        approvals: translate("defaultPermissionMode", copilot.defaultPermissionMode, APPROVALS),
      }),
    };
  }

  if (copilot.assistedApprovalInstructions !== undefined) {
    settings["chat.permissions.assisted.instructions"] = expectType(
      "assistedApprovalInstructions",
      copilot.assistedApprovalInstructions,
      "string",
    );
  }

  // VS Code keeps its own default model and stores the effort per model, so the CLI effort is
  // applied to the CLI model only. Auto has tiers instead of an effort.
  const model = copilot.model;
  const isAuto = typeof model === "string" && ["auto", "fusion"].includes(model.trim().toLowerCase());
  const isCopilotModel = (copilot.modelProviderId ?? "copilot") === "copilot";
  if (copilot.effortLevel !== undefined && typeof model === "string" && !isAuto && isCopilotModel) {
    const effort = expectType("effortLevel", copilot.effortLevel, "string");
    if (!EFFORTS.includes(effort)) {
      throw new Error(`effortLevel: VS Code has no value for ${JSON.stringify(effort)}`);
    }
    languageModels.push({
      name: "Copilot",
      vendor: "agent-host-copilotcli",
      settings: { [model]: { thinkingLevel: effort } },
    });
  }

  return {
    "settings.json": settings,
    "globalStorage/agent-host-config.json": agentHostConfig,
    "chatLanguageModels.json": languageModels,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [copilotPath, userDir] = process.argv.slice(2);
  if (!copilotPath || !userDir) {
    console.error("usage: copilot-vscode-sync.mjs COPILOT_SETTINGS VSCODE_USER_DIR");
    process.exit(2);
  }
  try {
    const derived = vscodeSettingsFromCopilot(JSON.parse(readFileSync(copilotPath, "utf8")));
    for (const [file, values] of Object.entries(derived)) {
      if (Object.keys(values).length > 0 && mergeIntoFile(values, join(userDir, file))) {
        console.log(`changed: ${file}`);
      }
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
