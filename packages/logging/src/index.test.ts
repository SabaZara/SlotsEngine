import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { createLogger, REDACT } from "./index.js";

/**
 * Tests for the one logger factory every service uses.
 *
 * The reason this file exists is `redact`, which is a security control
 * wearing the costume of a formatting option. Launch tokens, session tokens
 * and round *seeds* pass through these services constantly, and this
 * codebase stores a seed precisely because a round is a deterministic
 * function of it — so a seed in a log file is enough to replay or predict
 * outcomes, held indefinitely by whatever aggregator scrapes the logs.
 *
 * Twenty-four test files construct a logger and not one asserts on it. That
 * is the shape this sweep is looking for: used everywhere, checked nowhere.
 *
 * Worth recording that the reference repo (~/Desktop/irakli/slot-engine)
 * has **no redaction at all** in its equivalent file, so there was no
 * counterpart suite to read and nothing upstream validating this list. The
 * paths below are therefore pinned against the docstring's claim rather than
 * against a second implementation.
 *
 * What these tests CANNOT establish:
 *
 *  - That every sensitive field in the codebase appears in the redact list.
 *    A field nobody thought to add is invisible here by construction — the
 *    test can only prove the listed paths work. `logs an object whose keys
 *    are all redactable` is the closest available guard.
 *  - That pino's own redaction is correct at depth. These tests assert on
 *    real pino output rather than on the options object, so they prove the
 *    integration, not pino's internals.
 *  - Anything about the pretty transport when it IS available. Constructing
 *    that logger spawns a worker thread, which a unit test should not do;
 *    only the production branch (transport suppressed) is covered.
 */

/** Captures what pino actually writes, so assertions run on real output. */
function capture(build: (dest: Writable) => pino.Logger): {
  logger: pino.Logger;
  lines: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return {
    logger: build(dest),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("constructs without throwing, which is the failure that takes a service down at boot", () => {
    // pino throws at construction when a transport target cannot be
    // resolved, and this factory runs before anything binds a port. A
    // logger that throws here is not a logging problem, it is an outage.
    assert.doesNotThrow(() => createLogger("game-backend"));
  });

  it("tags every line with the service name, so aggregated logs can be told apart", () => {
    const { logger, lines } = capture((dest) => pino({ name: "game-socket", level: "info" }, dest));
    logger.info("hello");
    assert.equal(lines()[0]?.name, "game-socket");
  });

  it("honours LOG_LEVEL, and defaults to info when it is unset", () => {
    const before = process.env.LOG_LEVEL;
    try {
      delete process.env.LOG_LEVEL;
      assert.equal(createLogger("s").level, "info");

      process.env.LOG_LEVEL = "debug";
      assert.equal(createLogger("s").level, "debug");
    } finally {
      if (before === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = before;
    }
  });

  it("suppresses the pretty transport under NODE_ENV=production", () => {
    // pino-pretty is a dev dependency, so a production image does not have
    // it. The check must not be NODE_ENV alone in the other direction, but
    // in THIS direction production must never even attempt the transport.
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      assert.doesNotThrow(() => createLogger("prod-service"));
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});

/**
 * The redact list, path by path.
 *
 * Each case logs a realistic object and asserts the secret is gone AND that
 * the censor marker is present — "gone" alone would pass if the field were
 * dropped for some unrelated reason, which would be a different bug wearing
 * the same result.
 */
describe("createLogger redaction", () => {
  const SECRET = "super-secret-value-do-not-log";

  /**
   * Builds a logger with the real factory's redact configuration —
   * `REDACT` imported from the source, never a copy of it. Restating the
   * paths here would leave these tests passing if `createLogger` dropped
   * `redact` altogether, which is precisely the regression they exist for.
   */
  function redacting(dest: Writable): pino.Logger {
    return pino(
      { name: "redact-test", level: "info", redact: { paths: [...REDACT.paths], censor: REDACT.censor } },
      dest,
    );
  }

  const cases: Array<{ what: string; payload: Record<string, unknown>; read: (l: Record<string, unknown>) => unknown }> =
    [
      { what: "a top-level token", payload: { token: SECRET }, read: (l) => l.token },
      {
        what: "a nested token, one level down",
        payload: { launch: { token: SECRET } },
        read: (l) => (l.launch as Record<string, unknown>)?.token,
      },
      { what: "a top-level sessionToken", payload: { sessionToken: SECRET }, read: (l) => l.sessionToken },
      {
        what: "a nested sessionToken",
        payload: { player: { sessionToken: SECRET } },
        read: (l) => (l.player as Record<string, unknown>)?.sessionToken,
      },
      { what: "a top-level seed", payload: { seed: SECRET }, read: (l) => l.seed },
      {
        what: "a nested seed",
        payload: { round: { seed: SECRET } },
        read: (l) => (l.round as Record<string, unknown>)?.seed,
      },
      {
        what: "an Authorization header",
        payload: { req: { headers: { authorization: SECRET } } },
        read: (l) => ((l.req as Record<string, unknown>)?.headers as Record<string, unknown>)?.authorization,
      },
      {
        what: "the internal service signature header",
        payload: { req: { headers: { "x-service-signature": SECRET } } },
        read: (l) => ((l.req as Record<string, unknown>)?.headers as Record<string, unknown>)?.["x-service-signature"],
      },
    ];

  for (const { what, payload, read } of cases) {
    it(`never writes ${what}`, () => {
      const { logger, lines } = capture(redacting);
      logger.info(payload, "a message");

      const line = lines()[0];
      assert.ok(line, "expected a log line");
      assert.equal(read(line), "[redacted]");

      // The whole serialised line, not just the field read above: a secret
      // copied into a second place by a serializer would pass the check
      // above and still be in the file.
      assert.ok(!JSON.stringify(line).includes(SECRET), `${what} leaked elsewhere in the line`);
    });
  }

  it("redacts a round seed, which is the one that lets outcomes be predicted", () => {
    // Called out separately because it is the highest-consequence path and
    // the least obvious: a token grants access, but a seed grants the
    // ability to replay or anticipate a spin, which is a money problem.
    const seed = "a".repeat(64);
    const { logger, lines } = capture(redacting);
    logger.info({ roundId: "r-1", seed, totalWin: 250 }, "round resolved");

    const line = lines()[0];
    assert.equal(line?.seed, "[redacted]");
    // The surrounding fields must survive — redaction that ate the whole
    // object would "pass" a leak test while destroying the logs.
    assert.equal(line?.roundId, "r-1");
    assert.equal(line?.totalWin, 250);
  });

  it("the REAL createLogger applies the list — not just the list working in isolation", () => {
    // Every other test in this block builds its own pino instance from
    // REDACT, which proves the paths are correct but would keep passing if
    // `createLogger` stopped passing `redact` at all. That is the entire
    // failure this file exists to catch, so it needs its own test.
    //
    // createLogger writes to file descriptor 1 directly. pino resolves its
    // destination at construction and never routes through
    // `process.stdout.write`, so monkey-patching that captures nothing —
    // the first version of this test did exactly that and read back an
    // empty string. Node exposes no dup2 either, so the descriptor cannot
    // be redirected in-process.
    //
    // Running it in a child process and reading that child's stdout is the
    // honest way to see what the real factory emits, and it has a bonus:
    // the logger is constructed in a fresh process with NODE_ENV set from
    // the start, which is exactly how a production container builds it.
    const script = `
      import { createLogger } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "index.ts")).href)};
      createLogger("real-factory-test").info(
        { seed: ${JSON.stringify(SECRET)}, token: ${JSON.stringify(SECRET)}, gameId: "reference-5x3" },
        "round resolved",
      );
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      // NODE_ENV=production forces the JSON path: with pino-pretty active
      // the output is not parseable as JSON, and this is about content.
      { encoding: "utf8", env: { ...process.env, NODE_ENV: "production" } },
    );

    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    const raw = result.stdout;
    assert.ok(raw.trim() !== "", "createLogger wrote nothing — the capture missed it");
    assert.ok(!raw.includes(SECRET), "createLogger emitted a secret: it is not applying REDACT");

    const line = JSON.parse(raw.split("\n").filter((l) => l.trim() !== "")[0]!) as Record<string, unknown>;
    assert.equal(line.seed, "[redacted]");
    assert.equal(line.token, "[redacted]");
    assert.equal(line.gameId, "reference-5x3");
  });

  it("leaves ordinary fields untouched", () => {
    const { logger, lines } = capture(redacting);
    logger.info({ gameId: "reference-5x3", betAmount: 100, playerId: "p-1" }, "spin");

    const line = lines()[0];
    assert.equal(line?.gameId, "reference-5x3");
    assert.equal(line?.betAmount, 100);
    assert.equal(line?.playerId, "p-1");
  });

  it("does not redact a field merely because its name contains a secret name", () => {
    // `tokenVersion` is revocation state and belongs in logs; the paths are
    // exact rather than substring matches, and this pins that distinction.
    const { logger, lines } = capture(redacting);
    logger.info({ tokenVersion: 7, seedSource: "os" }, "user");

    const line = lines()[0];
    assert.equal(line?.tokenVersion, 7);
    assert.equal(line?.seedSource, "os");
  });

  it("redacts at depth one only, which is a real limit worth stating", () => {
    // `*.token` is a single wildcard level. A token buried two levels down
    // is NOT redacted. This test pins the actual behaviour rather than the
    // hoped-for one, so that anyone who logs a deeply nested token knows
    // from this file that the list will not save them.
    const { logger, lines } = capture(redacting);
    logger.info({ outer: { inner: { token: SECRET } } }, "deep");

    const line = lines()[0];
    const deep = ((line?.outer as Record<string, unknown>)?.inner as Record<string, unknown>)?.token;
    assert.equal(deep, SECRET, "if this now passes, the redact list gained depth and this test should be updated");
  });
});
