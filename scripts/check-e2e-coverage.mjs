#!/usr/bin/env node
/**
 * Every `e2e:*` script in package.json must be run by CI.
 *
 * This exists because the list in `.github/workflows/ci.yml` is
 * hand-maintained, and it has now drifted twice. `e2e:operator` shipped
 * with the operator integration and was never added, so the entire
 * external-facing surface — signed wallet calls, the launch handoff,
 * single-use tokens, the player-limit routes — was verified only on a
 * developer's laptop while CI reported success on every push.
 *
 * The failure mode is the one this repo keeps meeting: **nothing breaks.**
 * A check that is not wired up does not fail, it is simply absent, and the
 * green tick looks identical either way. F4 was discovery silently covering
 * a fraction of the suite; F24 was a second copy of a list drifting from
 * the thing it mirrored. This is both at once.
 *
 * Deliberately a *source-level* check rather than something clever. It
 * greps a YAML file for a string, which cannot tell whether the step is
 * inside the right job, guarded by an `if:`, or ever actually reached. What
 * it can tell you is that a script exists and nothing anywhere mentions it,
 * which is the whole of the drift observed so far.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");

const scripts = Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith("e2e:"));

if (scripts.length === 0) {
  console.error("No e2e:* scripts found — that is a bug in this check, not a clean package.json.");
  process.exit(1);
}

/**
 * Only `run:` lines count, and comments are stripped first.
 *
 * A plain substring search over the whole file passed while the step was
 * deleted, because the *comment* explaining why the step exists also
 * contains `npm run e2e:operator`. Observed, not theorised: the first draft
 * of this check reported all four wired with the operator step removed.
 * A guard whose own documentation satisfies it is worse than no guard.
 */
const commands = workflow
  .split("\n")
  .map((line) => line.replace(/#.*$/, ""))
  .filter((line) => /(^|\s)run:\s/.test(line) || /^\s+npm run /.test(line))
  .join("\n");

const missing = scripts.filter((name) => !new RegExp(`npm run ${name}(\\s|$)`).test(commands));

for (const name of scripts) {
  console.log(`  ${missing.includes(name) ? "MISSING" : "ok     "}  ${name}`);
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} e2e script(s) are never run by CI: ${missing.join(", ")}\n` +
      `Add a step to .github/workflows/ci.yml, or delete the script if it is dead.\n` +
      `An end-to-end check nobody runs is worse than one that does not exist — it looks like cover.`,
  );
  process.exit(1);
}

console.log(`\nAll ${scripts.length} e2e scripts are wired into CI.`);
