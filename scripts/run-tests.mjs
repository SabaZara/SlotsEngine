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

/** Every *.test.ts and *.test.tsx under a src/ directory, found by walking
 * rather than globbing. `.tsx` is included because the React component
 * tests are written in JSX; they are run separately below, since they need
 * a tsconfig this repo's root does not provide. */
function findTests(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findTests(full, found);
    } else if ((entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) && full.includes(`${"src"}/`)) {
      found.push(relative(root, full));
    }
  }
  return found;
}

const all = ROOTS.flatMap((r) => findTests(join(root, r))).sort();
const files = all.filter((f) => !f.endsWith(".test.tsx"));
const jsxFiles = all.filter((f) => f.endsWith(".test.tsx"));

if (all.length === 0) {
  console.error("No test files found — that is a bug in this script, not a clean suite.");
  process.exit(1);
}

// Printed so a CI log records what actually ran. The whole class of bug
// this script exists to prevent is a suite that quietly shrinks.
console.log(`Running ${files.length} test files (+ ${jsxFiles.length} component)\n`);

// Resolved from node_modules rather than trusting PATH: with shell:false
// there is no shell to search PATH, and npm only puts .bin on PATH for the
// script it launches, not for a child process this script spawns.
const tsx = join(root, "node_modules", ".bin", "tsx");

function run(args) {
  const result = spawnSync(tsx, args, { stdio: "inherit", cwd: root, shell: false });
  // A spawn that never started reports an error rather than an exit code,
  // and swallowing it is how this script previously "passed" while running
  // nothing.
  if (result.error) {
    console.error(`Could not run ${tsx}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

let status = run(["--test", ...files]);

/**
 * The component tests run as a second invocation, with an explicit
 * `--tsconfig`.
 *
 * Not cosmetic: there is no `tsconfig.json` at this repo's root, so tsx
 * falls back to esbuild's default JSX handling — the *classic* runtime,
 * which emits `React.createElement` into files that never import React.
 * Every component test then fails with `ReferenceError: React is not
 * defined`, which names the symptom and not the cause. Pointing at the
 * frontend's own test config supplies `jsx: "react-jsx"`, the automatic
 * runtime the app itself is built with.
 *
 * A root tsconfig would fix it globally and was rejected: it would also
 * become the resolution base for every other workspace, which is a much
 * larger change than making one runner flag explicit.
 */
if (jsxFiles.length > 0) {
  const jsxTsconfig = join(root, "apps", "backoffice-frontend", "tsconfig.test.json");
  const jsxStatus = run(["--tsconfig", jsxTsconfig, "--test", ...jsxFiles]);
  // Either suite failing fails the run — a green unit suite must not mask a
  // red component one.
  if (status === 0) status = jsxStatus;
}

process.exit(status);
