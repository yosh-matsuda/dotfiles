#!/usr/bin/env node
// Merge tracked VS Code settings, keybindings, or language model settings into a live JSONC user file.
// An object is merged key by key. In an array, an entry with a vendor is merged leaf by leaf into
// the live entry of the same vendor, and any other entry is added when it is missing.
// Prints "changed" when the live file was written.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import jsonc from "jsonc-parser";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Returns true when the live file was written.
export function mergeIntoFile(tracked, livePath) {
  const isArray = Array.isArray(tracked);
  const original = existsSync(livePath) ? readFileSync(livePath, "utf8") : "";
  let text = original.trim() ? original : isArray ? "[]\n" : "{}\n";

  const errors = [];
  let live = jsonc.parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`${livePath}: invalid JSONC at offset ${errors[0].offset}`);
  }
  if (Array.isArray(live) !== isArray || live === null || typeof live !== "object") {
    throw new Error(`${livePath}: expected a JSON ${isArray ? "array" : "object"}`);
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
    // A later tracked entry of the same vendor has to see what this edit added.
    live = jsonc.parse(text, [], { allowTrailingComma: true });
    changed = true;
  };
  const mergeLeaves = (path, liveValue, trackedValue) => {
    if (isPlainObject(trackedValue) && isPlainObject(liveValue)) {
      for (const [key, value] of Object.entries(trackedValue)) {
        mergeLeaves([...path, key], liveValue[key], value);
      }
    } else if (!isDeepStrictEqual(liveValue, trackedValue)) {
      apply(path, trackedValue);
    }
  };

  if (isArray) {
    for (const entry of tracked) {
      if (isPlainObject(entry) && typeof entry.vendor === "string") {
        const matches = live.flatMap((item, index) => (isPlainObject(item) && item.vendor === entry.vendor ? [index] : []));
        if (matches.length > 1) {
          throw new Error(`${livePath}: ${matches.length} entries have the vendor ${entry.vendor}`);
        }
        if (matches.length === 1) {
          mergeLeaves([matches[0]], live[matches[0]], entry);
          continue;
        }
      }
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
    mkdirSync(dirname(livePath), { recursive: true });
    writeFileSync(livePath, text);
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [trackedPath, livePath] = process.argv.slice(2);
  if (!trackedPath || !livePath) {
    console.error("usage: vscode-settings-merge.mjs TRACKED LIVE");
    process.exit(2);
  }
  try {
    if (mergeIntoFile(JSON.parse(readFileSync(trackedPath, "utf8")), livePath)) {
      console.log("changed");
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
