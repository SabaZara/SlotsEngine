/**
 * Storage keys, and the rule that stops a signed URL being stored as one.
 *
 * **These tests are aimed at a specific bug the reference repo shipped to
 * production**, because this design has the same shape and would have the
 * same bug without them. Storing a key and signing at serve time means what
 * a client reads differs from what the server stores — and their
 * draft-update route wrote the read shape back over the stored one. Every
 * "Save draft" nested the URL one level deeper, and it took a repair script
 * with a recursive unwinder to recover the data.
 *
 * The primary defence is that the draft write path refuses `assets`
 * entirely (see `drafts.ts`). `isStorageKey` is defence in depth: if that
 * is ever bypassed, one bad write is refused rather than compounding.
 *
 * So the load-bearing cases here are the *rejections*, and specifically the
 * ones that are not obviously URLs — a protocol-relative `//host/path`
 * looks nothing like `http://` and a browser fetches it just the same.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_CONTENT_TYPES,
  EXTENSION_FOR_TYPE,
  UPLOAD_SLOTS,
  buildAssetKey,
  isAllowedForSlot,
  isStorageKey,
  isUploadSlot,
} from "./keys.js";

describe("isStorageKey", () => {
  it("accepts a key of the shape this package produces", () => {
    assert.equal(isStorageKey("games/reference-5x3/symbol/a1b2c3.png"), true);
  });

  it("refuses a signed URL, which is the corruption the reference shipped", () => {
    /*
     * The exact failure. Their GET returned signed URLs, their PUT stored
     * whatever the client sent back, and the value grew one nesting level
     * per save.
     */
    assert.equal(
      isStorageKey("http://localhost:9010/game-assets/games/x/symbol/a.png?X-Amz-Signature=deadbeef"),
      false,
    );
  });

  it("refuses an already-corrupted key, so the nesting cannot restart", () => {
    // What the second save produced in their data: a URL whose path is a
    // url-encoded URL. Refusing it means a repair script never becomes
    // necessary a second time.
    assert.equal(isStorageKey("http://host/bucket/http%3A%2F%2Fhost%2Fbucket%2Fgames%2Fx%2Fa.png"), false);
  });

  it("refuses a protocol-relative URL, which does not start with http and is still a URL", () => {
    /*
     * The case a naive "does it start with http" check misses entirely. A
     * browser resolves `//evil.example/x` against the page's own scheme and
     * fetches it, so this is a URL in every way that matters.
     */
    assert.equal(isStorageKey("//evil.example/pixel.png"), false);
  });

  it("refuses any scheme, not just http", () => {
    assert.equal(isStorageKey("https://host/a.png"), false);
    assert.equal(isStorageKey("javascript:alert(1)"), false);
    assert.equal(isStorageKey("data:image/png;base64,AAAA"), false);
    assert.equal(isStorageKey("s3://bucket/key"), false);
  });

  it("refuses a value carrying a query or fragment", () => {
    // A signed URL's signature lives in the query, so a value with one is
    // an address rather than a key even if the scheme were stripped.
    assert.equal(isStorageKey("games/x/symbol/a.png?X-Amz-Signature=abc"), false);
    assert.equal(isStorageKey("games/x/symbol/a.png#frag"), false);
  });

  it("refuses path traversal and absolute paths", () => {
    // A key is a path, and per-game isolation depends on the prefix. A
    // caller who can write `../` writes outside it.
    assert.equal(isStorageKey("games/x/../../etc/passwd"), false);
    assert.equal(isStorageKey("/etc/passwd"), false);
  });

  it("refuses whitespace, which no generated key contains", () => {
    assert.equal(isStorageKey("games/x/sym bol/a.png"), false);
    assert.equal(isStorageKey(" games/x/a.png"), false);
  });

  it("refuses anything that is not a string", () => {
    // This crosses a socket and a database, so the type is a claim.
    assert.equal(isStorageKey(undefined), false);
    assert.equal(isStorageKey(null), false);
    assert.equal(isStorageKey(""), false);
    assert.equal(isStorageKey(["games/x/a.png"]), false);
  });
});

describe("buildAssetKey", () => {
  it("groups a game's assets under one prefix", () => {
    // Game first so a game's assets are listable and deletable as a unit.
    const key = buildAssetKey("reference-5x3", "symbol", "png", "a1b2c3");

    assert.equal(key, "games/reference-5x3/symbol/a1b2c3.png");
  });

  it("produces something `isStorageKey` accepts", () => {
    // The two halves of this file must agree, or an upload stores a value
    // the guard will refuse on the next read.
    assert.equal(isStorageKey(buildAssetKey("g", "background", "webp", "xyz")), true);
  });

  it("strips path separators out of a game id, so a key cannot escape its prefix", () => {
    /*
     * A gameId is chosen by a designer and reaches this function directly.
     * Without sanitising, `../../` in an id writes outside the games
     * prefix — and per-game isolation is the only thing keeping one game's
     * upload from overwriting another's.
     */
    const key = buildAssetKey("../../etc", "symbol", "png", "r");

    assert.ok(!key.includes(".."), `key escaped its prefix: ${key}`);
    assert.equal(isStorageKey(key), true);
  });

  it("strips a slot that tries the same trick", () => {
    const key = buildAssetKey("g", "../../..", "png", "r");

    assert.ok(!key.includes(".."), `key escaped its prefix: ${key}`);
  });

  it("keeps the extension to plain characters", () => {
    // The extension is derived from a content type, but a caller-supplied
    // one must not be able to append a second path segment.
    const key = buildAssetKey("g", "symbol", "png/../../x", "r");

    assert.ok(!key.includes(".."));
    assert.equal(isStorageKey(key), true);
  });
});

describe("upload slots", () => {
  it("accepts only the slots the server understands", () => {
    // Enumerated so an upload cannot choose where in `assets` to write —
    // the same class of problem as accepting the whole object.
    for (const slot of UPLOAD_SLOTS) assert.equal(isUploadSlot(slot), true);
    assert.equal(isUploadSlot("symbolImageUrls"), false);
    assert.equal(isUploadSlot("__proto__"), false);
    assert.equal(isUploadSlot(undefined), false);
  });

  it("gives every slot a content-type allowlist", () => {
    // Guards the two tables against drifting apart: a slot with no entry
    // would reject every upload, which reads as a broken button.
    for (const slot of UPLOAD_SLOTS) {
      assert.ok(ALLOWED_CONTENT_TYPES[slot]?.length > 0, `${slot} has no allowed types`);
    }
  });

  it("knows an extension for every type it allows", () => {
    // A type allowed but unmapped would store a key with no extension,
    // which some CDNs and browsers treat as an unknown download.
    for (const slot of UPLOAD_SLOTS) {
      for (const type of ALLOWED_CONTENT_TYPES[slot]) {
        assert.ok(EXTENSION_FOR_TYPE[type], `no extension mapped for ${type}`);
      }
    }
  });

  it("keeps images out of audio slots and the reverse", () => {
    assert.equal(isAllowedForSlot("music", "image/png"), false);
    assert.equal(isAllowedForSlot("symbol", "audio/mpeg"), false);
    assert.equal(isAllowedForSlot("symbol", "image/png"), true);
    assert.equal(isAllowedForSlot("music", "audio/mpeg"), true);
  });

  it("tolerates the charset a browser appends", () => {
    // `multipart/form-data` parts routinely arrive as
    // "image/png; charset=binary", and refusing those would fail a
    // perfectly ordinary upload.
    assert.equal(isAllowedForSlot("symbol", "image/png; charset=binary"), true);
    assert.equal(isAllowedForSlot("symbol", "IMAGE/PNG"), true);
  });

  it("refuses a type nobody allowed", () => {
    assert.equal(isAllowedForSlot("symbol", "application/pdf"), false);
    assert.equal(isAllowedForSlot("symbol", "text/html"), false);
  });
});
