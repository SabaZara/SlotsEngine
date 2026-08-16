#!/usr/bin/env node
/**
 * Finds every test file and hands the explicit list to tsx.
 *
 * Why this exists rather than a glob in package.json: glob support differs
 * both by shell and by Node version, and every variation fails *quietly*.
 * `packages/*​/src/**​/*.test.ts` matched all 15 files under zsh and 2 under
 * dash — npm runs scripts under `sh`, so which one you got depended on the
 * machine. Node's own runner only learned to expand globs in 22, so on the
 * Node 20 this project pins, every pattern form fails outright.
 *
 * A test command that silently runs a third of the suite is worse than one
 * that errors: it reports success. Resolving the list here removes the
 * shell and the Node version from the question entirely.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["packages", "apps"];
const SKIP = new Set(["node_modules", "dist", ".git"]);

/** Every *.test.ts under a src/ directory, found by walking rather than globbing. */
function findTests(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findTests(full, found);
    } else if (entry.endsWith(".test.ts") && full.includes(`${"src"}/`)) {
      found.push(relative(root, full));
    }
  }
  return found;
}

const files = ROOTS.flatMap((r) => findTests(join(root, r))).sort();

if (files.length === 0) {
  console.error("No test files found — that is a bug in this script, not a clean suite.");
  process.exit(1);
}

// Printed so a CI log records what actually ran. The whole class of bug
// this script exists to prevent is a suite that quietly shrinks.
console.log(`Running ${files.length} test files\n`);

// Resolved from node_modules rather than trusting PATH: with shell:false
// there is no shell to search PATH, and npm only puts .bin on PATH for the
// script it launches, not for a child process this script spawns.
const tsx = join(root, "node_modules", ".bin", "tsx");

const result = spawnSync(tsx, ["--test", ...files], {
  stdio: "inherit",
  cwd: root,
  shell: false,
});

// A spawn that never started reports an error rather than an exit code, and
// swallowing it is how this script previously "passed" while running nothing.
if (result.error) {
  console.error(`Could not run ${tsx}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
