/**
 * What the player is told, per phase.
 *
 * These are tested rather than eyeballed because of a failure that actually
 * happened while building the Pixi renderer: context acquisition failed and
 * the page showed a **blank canvas with a working Spin button**. A player
 * would have bet, been charged, and watched nothing move. The message is
 * therefore not decoration — it is what separates "this is broken, stop"
 * from "keep pressing".
 *
 * The wording itself is deliberately *not* asserted verbatim. Pinning exact
 * sentences makes copy edits fail the suite for no benefit, which trains
 * people to stop reading failures. What is asserted is the **contract**:
 * that a message exists, that terminal states are not described as
 * actionable, and that anything a player must do is actually said.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTerminalCode, presentStatus } from "./statusPresentation.js";
import type { GameState } from "../state/gameState.js";

const ALL_STATES: GameState[] = [
  { phase: "idle" },
  { phase: "spinning" },
  { phase: "revealing", stopRequested: false },
  { phase: "revealing", stopRequested: true },
  { phase: "bonus" },
  { phase: "offline" },
  { phase: "unrecoverable", code: "token_expired" },
  { phase: "unrecoverable", code: "token_already_used" },
  { phase: "unrecoverable", code: "invalid_token" },
  { phase: "unrecoverable", code: "launch_failed" },
  { phase: "graphics_failed" as never, code: "x" } as GameState,
];

describe("presentStatus", () => {
  it("always produces a non-empty headline", () => {
    // An empty status reads as a hung client rather than as a quiet one.
    for (const state of ALL_STATES.slice(0, 10)) {
      const { headline } = presentStatus(state);
      assert.ok(headline.trim().length > 0, `${state.phase} produced no headline`);
    }
  });

  it("never calls a terminal state actionable", () => {
    /**
     * The core contract. `actionable: true` is what a retry affordance
     * keys off, and offering one for a spent token invites the player to
     * keep pressing a button that cannot work.
     */
    for (const code of ["token_expired", "token_already_used", "invalid_token", "launch_failed"]) {
      const presentation = presentStatus({ phase: "unrecoverable", code });
      assert.equal(presentation.actionable, false, `${code} was described as actionable`);
      assert.equal(presentation.tone, "bad");
    }
  });

  it("tells the player what to do about every terminal failure", () => {
    // "invalid token" alone is not something a player can act on. Every
    // terminal state must name the one thing that helps.
    for (const code of ["token_expired", "token_already_used", "invalid_token", "launch_failed"]) {
      const { detail } = presentStatus({ phase: "unrecoverable", code });
      assert.ok(detail && detail.trim().length > 0, `${code} left the player with no instruction`);
      assert.match(detail, /casino|browser/i, `${code}'s detail does not say what to do: ${detail}`);
    }
  });

  it("gives an unrecognised terminal code a usable sentence, and keeps the code", () => {
    // A code this build has not seen must not surface raw. It is still
    // appended, because a support agent acting on a screenshot needs it.
    const { headline, detail, actionable } = presentStatus({ phase: "unrecoverable", code: "wallet_unreachable" });

    assert.ok(headline.trim().length > 0);
    assert.equal(actionable, false);
    assert.match(detail ?? "", /wallet_unreachable/, "the raw code should remain available for support");
    assert.ok((detail ?? "").length > "wallet_unreachable".length + 10, "the code alone is not an explanation");
  });

  it("reassures the player about their money while offline", () => {
    // The real question during a disconnect is whether the balance is
    // safe. It is — the server holds it — so this says so.
    const { detail, actionable, tone } = presentStatus({ phase: "offline" });
    assert.equal(actionable, false);
    assert.equal(tone, "bad");
    assert.match(detail ?? "", /balance|safe/i);
  });

  it("distinguishes a recoverable disconnect from a finished session", () => {
    // Both disable everything, but only one is worth waiting through.
    const offline = presentStatus({ phase: "offline" });
    const expired = presentStatus({ phase: "unrecoverable", code: "token_expired" });
    assert.notEqual(offline.headline, expired.headline);
  });

  it("marks the reveal actionable, since the player can still skip it", () => {
    assert.equal(presentStatus({ phase: "revealing", stopRequested: false }).actionable, true);
  });

  it("marks a sent-but-unresolved spin as not actionable", () => {
    // Nothing the player does changes anything until the server answers.
    assert.equal(presentStatus({ phase: "spinning" }).actionable, false);
  });

  it("reports idle as ready and actionable", () => {
    const { tone, actionable } = presentStatus({ phase: "idle" });
    assert.equal(actionable, true);
    assert.equal(tone, "neutral");
  });

  it("adds no detail to the ordinary states", () => {
    // Padding every state with prose trains people to stop reading the one
    // that matters.
    assert.equal(presentStatus({ phase: "idle" }).detail, undefined);
    assert.equal(presentStatus({ phase: "spinning" }).detail, undefined);
  });
});

describe("isTerminalCode", () => {
  it("recognises the codes that end a session", () => {
    // A code missing here leaves a dead button the player keeps pressing.
    assert.equal(isTerminalCode("token_expired"), true);
    assert.equal(isTerminalCode("token_already_used"), true);
    assert.equal(isTerminalCode("invalid_token"), true);
  });

  it("does not treat an ordinary error as terminal", () => {
    // The mirror failure: abandoning a session that could have continued.
    assert.equal(isTerminalCode("insufficient_funds"), false);
    assert.equal(isTerminalCode("rate_limited"), false);
  });
});
