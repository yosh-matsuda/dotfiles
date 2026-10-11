#!/usr/bin/env node
// Merge tracked VS Code settings or keybindings into a live JSONC user file.
// An object is merged key by key; an array adds the entries that are missing.
// Prints "changed" when the live file was written.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import jsonc from "jsonc-parser";

const [trackedPath, livePath] = process.argv.slice(2);
if (!trackedPath || !livePath) {
  console.error("usage: vscode-settings-merge.mjs TRACKED LIVE");
  process.exit(2);
}

const tracked = JSON.parse(readFileSync(trackedPath, "utf8"));
const isArray = Array.isArray(tracked);
const original = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
let text = original.trim() ? original : isArray ? "[]\n" : "{}\n";

const errors = [];
const live = jsonc.parse(text, errors, { allowTrailingComma: true });
if (errors.length > 0) {
  console.error(`${livePath}: invalid JSONC at offset ${errors[0].offset}`);
  process.exit(1);
}
if (Array.isArray(live) !== isArray || live === null || typeof live !== "object") {
  console.error(`${livePath}: expected a JSON ${isArray ? "array" : "object"}`);
  process.exit(1);
}

const indent = text.match(/^([ \t]+)\S/m)?.[1] ?? "    ";
const formattingOptions = {
  insertSpaces: !indent.startsWith("\t"),
  tabSize: indent.startsWith("\t") ? 4 : indent.length,
  eol: text.includes("\r\n") ? "\r\n" : "\n",
};

let changed = false;
const apply = (path, value, options = {}) => {
  text = jsonc.applyEdits(text, jsonc.modify(text, path, value, { formattingOptions, ...options }));
  changed = true;
};

if (isArray) {
  for (const entry of tracked) {
    if (!live.some((item) => isDeepStrictEqual(item, entry))) {
      apply([-1], entry, { isArrayInsertion: true });
    }
  }
} else {
  for (const [key, value] of Object.entries(tracked)) {
    if (!isDeepStrictEqual(live[key], value)) {
      apply([key], value);
    }
  }
}

if (changed) {
  writeFileSync(livePath, text);
  console.log("changed");
}
