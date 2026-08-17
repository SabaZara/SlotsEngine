import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MAX_SKEW_MS } from "./auth/middleware.js";
import { TRANSACTION_PAGE_LIMIT } from "./routes/wallet.js";

/**
 * `docs/INTEGRATION.md` against the code it describes.
 *
 * **Why this file exists.** The published integration document is the only
 * thing an outside developer has. They cannot read our source, so every
 * number in it is a promise, and a promise nothing checks is exactly the
 * shape of F27: a value that *looks* authoritative, is wrong, and fails
 * for someone else at a time when nobody is looking at the file that
 * caused it.
 *
 * This is not hypothetical. **The reference repo's own OpenAPI spec has
 * this bug today**: it declares `amount: { type: number, exclusiveMinimum:
 * 0 }` while its wallet route requires `Number.isInteger`. An integrator
 * generating a client from that spec produces one that sends `10.5` and is
 * rejected — and the spec, being a static file nothing runs, goes on saying
 * so indefinitely. Ours will not, because this test fails first.
 *
 * What it deliberately does NOT do: assert on prose. Tests that match
 * sentences make copy edits fail the suite, which teaches people to ignore
 * failures. It checks the things an integrator *builds against* — error
 * codes, limits, and the constants that change client behaviour.
 *
 * What it cannot establish: that the document is *clear*, or that the
 * worked example is one the server accepts. The second is real and belongs
 * to `npm run e2e:operator`, which signs a request the way the document
 * describes and sends it to the running service.
 */

const DOC = readFileSync(fileURLToPath(new URL("../../../docs/INTEGRATION.md", import.meta.url)), "utf8");

/**
 * Every `error: "..."` string the service can actually emit, read from
 * source rather than listed by hand — a hand-maintained list is a second
 * copy that drifts, which is the problem this file exists to prevent.
 */
function errorCodesInSource(): Set<string> {
  const sourceDir = fileURLToPath(new URL(".", import.meta.url));
  const files = [
    "auth/middleware.ts",
    "routes/wallet.ts",
    "routes/launch.ts",
    "routes/games.ts",
    "routes/limits.ts",
    "app.ts",
  ];

  const codes = new Set<string>();
  for (const file of files) {
    const source = readFileSync(`${sourceDir}${file}`, "utf8");
    for (const match of source.matchAll(/error: "([a-z_]+)"/g)) {
      codes.add(match[1]!);
    }
  }
  return codes;
}

/**
 * The error codes listed in the document's error TABLE — the part an
 * integrator writes a handler against — rather than anywhere the code
 * happens to be mentioned. Several are named in the prose as well, so a
 * whole-document search would report a table row as present after it had
 * been deleted.
 */
function documentedCodes(): string[] {
  return [...DOC.matchAll(/^\| \d{3} \| `([a-z_]+)`/gm)].map((match) => match[1]!);
}

describe("the published integration document", () => {
  it("lists every error code the service can return in the error table", async () => {
    // The direction that matters most to an integrator: an undocumented
    // code is one they cannot write a handler for, and they meet it in
    // production.
    //
    // Matched against the **table rows specifically**, not the whole
    // document, and that distinction was found by mutation testing:
    // deleting the `replayed_request` row survived a plain
    // `DOC.includes()`, because the code is also named in the prose above.
    // Prose explains; the table is what someone builds a switch statement
    // from, so the table is what has to be complete.
    const undocumented = [...errorCodesInSource()].filter((code) => {
      // `internal_error` is deliberately absent from the table: it carries
      // no actionable detail by design, and documenting it as something to
      // handle would imply it does.
      if (code === "internal_error") return false;
      return !documentedCodes().includes(code);
    });

    assert.deepEqual(undocumented, [], "these error codes are emitted but not listed in the error table");
  });

  it("documents no error code the service cannot return", async () => {
    // The other direction, which is subtler and worse: a code that was
    // renamed leaves the document telling people to handle something that
    // will never arrive, while the code that *does* arrive is unlisted.
    const emitted = errorCodesInSource();
    const documented = documentedCodes();

    assert.ok(documented.length > 0, "the premise: the error table was found and parsed");

    /**
     * Codes an integrator genuinely receives that this service does not
     * itself emit.
     *
     * The limit refusals are raised by `game-backend` when the player
     * spins, not by any route here — but they reach the operator's own
     * players, and an integrator who has just configured limits through
     * `PUT /v1/players/limits` is exactly who needs to know what a refusal
     * looks like. Documenting them is right; the check has to know that.
     *
     * Kept as a short explicit list rather than by widening the source
     * sweep to another service, because every entry should cost someone a
     * deliberate decision — this is the escape hatch that would otherwise
     * quietly become "the check no longer checks anything".
     */
    const RAISED_ELSEWHERE = ["stake_limit_reached", "loss_limit_reached"];

    const phantom = documented.filter((code) => !emitted.has(code) && !RAISED_ELSEWHERE.includes(code));
    assert.deepEqual(phantom, [], "these codes are documented but no longer emitted");
  });

  it("states the skew window the middleware actually enforces", () => {
    // An integrator whose clock drifts sees `timestamp_out_of_range` and
    // needs to know the tolerance to diagnose it.
    //
    // Accepts the numeral or the word, because pinning one would be a test
    // about prose style rather than about correctness — and the first
    // version of this test did exactly that, failing on a document that was
    // entirely accurate but wrote "five". The value is the claim; how it is
    // spelled is not.
    const minutes = MAX_SKEW_MS / 60_000;
    const spelled = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][minutes];
    const stated = new RegExp(`\\b(${minutes}|${spelled})\\b[^.]{0,20}minutes`, "i");

    assert.match(DOC, stated, `the document must state the real skew window of ${minutes} minutes`);
  });

  it("states the statement page size the route actually applies", () => {
    // Paging on a wrong limit silently misses rows — the caller believes
    // they have read everything.
    assert.ok(
      DOC.includes(`${TRANSACTION_PAGE_LIMIT} rows`),
      `the document must state the real page limit of ${TRANSACTION_PAGE_LIMIT}`,
    );
  });

  it("states that amounts are integer minor units, which the routes enforce", () => {
    // The reference's spec gets exactly this wrong. Money is never a float
    // anywhere in this codebase, and a client generated from a document
    // that says otherwise is a client that gets 400s.
    const walletSource = readFileSync(fileURLToPath(new URL("./routes/wallet.ts", import.meta.url)), "utf8");
    assert.ok(walletSource.includes("Number.isInteger"), "the premise: the route really does require an integer");

    assert.ok(DOC.includes("integer minor units"), "the document must say amounts are integer minor units");
  });

  it("documents the canonical string in the form the server builds", () => {
    // The single hardest thing to re-implement, and the one where a wrong
    // document costs an integrator days: every failure looks identical
    // (`bad_signature`) regardless of which part is wrong.
    assert.ok(
      DOC.includes("<timestamp>.<METHOD>.<url>.<rawBody>"),
      "the document must show the canonical string's real shape",
    );

    // And that the shape it shows is the one `canonicalRequest` produces.
    const hmacSource = readFileSync(fileURLToPath(new URL("./auth/hmac.ts", import.meta.url)), "utf8");
    assert.ok(
      hmacSource.includes("`${timestamp}.${method.toUpperCase()}.${url}.${rawBody}`"),
      "the server must build the canonical string the document describes",
    );
  });

  it("names the three headers the middleware requires", () => {
    for (const header of ["X-Api-Key-Id", "X-Timestamp", "X-Signature"]) {
      assert.ok(DOC.includes(header), `${header} must be documented`);
      const middleware = readFileSync(fileURLToPath(new URL("./auth/middleware.ts", import.meta.url)), "utf8");
      assert.ok(middleware.includes(header.toLowerCase()), `${header} must actually be read by the middleware`);
    }
  });

  it("documents every route the service exposes", () => {
    // A route nobody documents is a feature nobody uses — item 10's whole
    // lesson, one layer over.
    const routes = ["/v1/games", "/v1/launch", "/v1/wallet/cash-in", "/v1/wallet/cash-out", "/v1/wallet/balance", "/v1/wallet/transactions"];
    const undocumented = routes.filter((route) => !DOC.includes(route));

    assert.deepEqual(undocumented, [], "these routes exist but are undocumented");
  });
});
