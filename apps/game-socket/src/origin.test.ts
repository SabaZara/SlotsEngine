import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertOriginPolicy, isOriginAllowed, loadOriginPolicy, type OriginPolicy } from "./origin.js";

const policy = (allowed: string[], requireAllowlist = false): OriginPolicy => ({ allowed, requireAllowlist });

describe("isOriginAllowed", () => {
  const configured = policy(["http://localhost:9104", "https://play.example.com"]);

  it("allows an origin on the list", () => {
    assert.equal(isOriginAllowed("http://localhost:9104", configured), true);
    assert.equal(isOriginAllowed("https://play.example.com", configured), true);
  });

  it("refuses an origin that is not on the list", () => {
    assert.equal(isOriginAllowed("https://evil.example", configured), false);
  });

  it("allows a request with no Origin, because only browsers send one", () => {
    // The e2e scripts, a load test and any server-side `ws` client send no
    // Origin. Refusing them would break every legitimate non-browser caller
    // while stopping nobody — anything that can omit the header can forge it.
    assert.equal(isOriginAllowed(undefined, configured), true);
    assert.equal(isOriginAllowed("", configured), true);
  });

  it("matches exactly, so a lookalike domain is not accepted", () => {
    // The classic suffix-matching hole: `endsWith("play.example.com")`
    // accepts all three of these, and each is registrable by an attacker.
    assert.equal(isOriginAllowed("https://notplay.example.com", configured), false);
    assert.equal(isOriginAllowed("https://play.example.com.evil.test", configured), false);
    assert.equal(isOriginAllowed("https://evil.test/play.example.com", configured), false);
  });

  it("does not accept a different scheme or port on an allowed host", () => {
    assert.equal(isOriginAllowed("https://localhost:9104", configured), false, "scheme is part of an origin");
    assert.equal(isOriginAllowed("http://localhost:9999", configured), false, "port is part of an origin");
    assert.equal(isOriginAllowed("http://play.example.com", configured), false, "the entry is https");
  });

  it("treats the host as case-insensitive, per RFC 6454", () => {
    assert.equal(isOriginAllowed("https://PLAY.example.COM", configured), true);
    assert.equal(isOriginAllowed("HTTPS://play.example.com", configured), true);
  });

  it("refuses the literal null origin a sandboxed or file:// document sends", () => {
    assert.equal(isOriginAllowed("null", configured), false);
  });

  it("refuses a header that is not a parseable origin", () => {
    // A browser never sends these, so anything here is a malformed client
    // or someone probing the comparison.
    assert.equal(isOriginAllowed("not a url", configured), false);
    assert.equal(isOriginAllowed("localhost:9104", configured), false, "no scheme is not an origin");
    assert.equal(isOriginAllowed("//localhost:9104", configured), false);
  });

  it("ignores anything after the origin itself", () => {
    // An origin has no path. A value carrying one must be compared on its
    // origin part, not accepted or rejected by raw string equality.
    assert.equal(isOriginAllowed("http://localhost:9104/some/path", configured), true);
    assert.equal(isOriginAllowed("https://evil.example/http://localhost:9104", configured), false);
  });

  it("allows any origin when no allowlist is configured", () => {
    // Development convenience only; production cannot reach this state
    // because `assertOriginPolicy` refuses to boot without a list.
    assert.equal(isOriginAllowed("https://anything.example", policy([])), true);
  });

  it("normalises the configured entries too, not just the incoming header", () => {
    // A trailing slash in the env var is the likeliest configuration slip,
    // and it must not silently disable the entry it was meant to allow.
    const sloppy = policy(["http://localhost:9104/", "HTTPS://Play.Example.com"]);
    assert.equal(isOriginAllowed("http://localhost:9104", sloppy), true);
    assert.equal(isOriginAllowed("https://play.example.com", sloppy), true);
  });

  it("ignores an unparseable entry rather than matching everything against it", () => {
    const broken = policy(["", "not a url", "http://localhost:9104"]);
    assert.equal(isOriginAllowed("http://localhost:9104", broken), true);
    assert.equal(isOriginAllowed("https://evil.example", broken), false);
    assert.equal(isOriginAllowed("not a url", broken), false, "garbage must not match garbage");
  });
});

describe("loadOriginPolicy", () => {
  it("reads an explicit list", () => {
    const loaded = loadOriginPolicy({ SOCKET_ALLOWED_ORIGINS: "https://a.example, https://b.example" });
    assert.deepEqual(loaded.allowed, ["https://a.example", "https://b.example"]);
  });

  it("falls back to GAME_CORS_ORIGINS, so both surfaces share one setting", () => {
    const loaded = loadOriginPolicy({ GAME_CORS_ORIGINS: "https://play.example.com" });
    assert.deepEqual(loaded.allowed, ["https://play.example.com"]);
  });

  it("prefers the socket-specific variable when both are set", () => {
    const loaded = loadOriginPolicy({
      SOCKET_ALLOWED_ORIGINS: "https://socket.example",
      GAME_CORS_ORIGINS: "https://http.example",
    });
    assert.deepEqual(loaded.allowed, ["https://socket.example"]);
  });

  it("defaults to the dev frontend origin", () => {
    assert.deepEqual(loadOriginPolicy({}).allowed, ["http://localhost:9104"]);
  });

  it("drops blank entries from a trailing or doubled comma", () => {
    const loaded = loadOriginPolicy({ SOCKET_ALLOWED_ORIGINS: "https://a.example,,https://b.example," });
    assert.deepEqual(loaded.allowed, ["https://a.example", "https://b.example"]);
  });

  it("treats an empty string as no allowlist rather than as one blank origin", () => {
    assert.deepEqual(loadOriginPolicy({ SOCKET_ALLOWED_ORIGINS: "" }).allowed, []);
  });

  it("requires an allowlist only in production", () => {
    assert.equal(loadOriginPolicy({ NODE_ENV: "production" }).requireAllowlist, true);
    assert.equal(loadOriginPolicy({ NODE_ENV: "development" }).requireAllowlist, false);
    assert.equal(loadOriginPolicy({}).requireAllowlist, false);
  });
});

describe("assertOriginPolicy", () => {
  it("accepts a configured list", () => {
    assert.doesNotThrow(() => assertOriginPolicy(policy(["http://localhost:9104"], true)));
  });

  it("refuses to boot in production without an allowlist", () => {
    assert.throws(() => assertOriginPolicy(policy([], true)), /must be set explicitly in production/);
  });

  it("allows an empty list outside production", () => {
    assert.doesNotThrow(() => assertOriginPolicy(policy([], false)));
  });

  it("refuses a wildcard, in production or not", () => {
    // `*` is a CORS idiom that does not transfer: a socket has no preflight,
    // so this is not a relaxed policy, it is no policy wearing one's clothes.
    assert.throws(() => assertOriginPolicy(policy(["*"], true)), /must not be '\*'/);
    assert.throws(() => assertOriginPolicy(policy(["*"], false)), /must not be '\*'/);
    assert.throws(() => assertOriginPolicy(policy(["http://localhost:9104", "*"], false)), /must not be '\*'/);
  });
});
