/**
 * Reading a bonus session's public state into what the panel should draw.
 *
 * These decisions can be wrong in ways a screenshot will not reveal — a tile
 * still clickable after it was picked, a spin button offered when no spins
 * remain, a resolved round that keeps rendering as playable. All three are
 * money-adjacent: a bonus is a round that has not finished paying, and the
 * panel is the only thing standing between a player and a step the server
 * will refuse.
 *
 * The governing rule pinned here: **dispatch is on the shape of the view,
 * never on a module id.** Keying off the id would put a second copy of the
 * module list in the client, which is F24's exact failure one layer over.
 *
 * What these cannot establish: that the panel is actually drawn, or that a
 * click reaches the socket. That is `main.ts`'s wiring, verified by running
 * the client.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BLANK_LABEL, HIDDEN_LABEL, readBonusPanel, tileClickable } from "./bonusView.js";

describe("readBonusPanel", () => {
  it("reports a resolved round, whatever its view still carries", () => {
    /**
     * Checked first and unconditionally. A resolved round is over even if
     * its view still holds `remaining` or `tileCount` from the last step —
     * treating it as playable leaves a player clicking at a settled result,
     * and every one of those clicks is a step the server refuses.
     */
    const panel = readBonusPanel({ status: "resolved", totalWin: 1960, view: { remaining: 3, tileCount: 9 } });

    assert.equal(panel.kind, "resolved");
    assert.equal(panel.kind === "resolved" && panel.totalWinMinor, 1960);
  });

  it("reports a resolved round that paid nothing", () => {
    // A losing bonus still resolves, and the panel must say so rather than
    // reading as though the round were still running.
    const panel = readBonusPanel({ status: "resolved", view: {} });
    assert.equal(panel.kind === "resolved" && panel.totalWinMinor, 0);
  });

  describe("wheel", () => {
    // Exactly what `wheel.start()` emits, so a change to the module's view
    // breaks this rather than silently changing what the panel reads.
    const view = { segmentIndex: 2, multiplier: 5, segments: [1, 2, 5, 10], totalWin: 500 };

    it("draws the wheel even though the round is already resolved", () => {
      /*
       * The bug this closes, and the ordering is the whole fix. `wheel`
       * resolves in `start()`, so its state arrives with
       * `status: "resolved"` — which used to match first and render a bare
       * total. The server sends the entire segment table and the player was
       * shown a number instead of the thing that produced it.
       *
       * The money was never wrong, which is precisely why it went unnoticed:
       * nothing downstream disagreed.
       */
      const panel = readBonusPanel({ status: "resolved", totalWin: 500, view });

      assert.equal(panel.kind, "wheel", "a resolved wheel must still be drawn as a wheel");
    });

    it("carries the segment landed on and the whole table", () => {
      const panel = readBonusPanel({ status: "resolved", totalWin: 500, view });

      assert.equal(panel.kind === "wheel" && panel.segmentIndex, 2);
      assert.deepEqual(panel.kind === "wheel" && panel.segments, [1, 2, 5, 10]);
      assert.equal(panel.kind === "wheel" && panel.totalWinMinor, 500);
    });

    it("agrees with itself about which multiplier was won", () => {
      // `multiplier` and `segments[segmentIndex]` are two statements of one
      // fact. A client that quietly preferred one would draw a pointer at a
      // wedge whose label contradicts the payout — the failure the whole
      // reveal exists to avoid.
      const panel = readBonusPanel({ status: "resolved", totalWin: 500, view });

      assert.equal(panel.kind === "wheel" && panel.multiplier, 5);
      assert.equal(
        panel.kind === "wheel" && panel.segments[panel.segmentIndex],
        5,
        "the segment landed on must carry the multiplier that was paid",
      );
    });

    it("is recognised by shape, not by a module id", () => {
      // F24's rule at this layer: the client holds no copy of the module
      // list. A view carrying segmentIndex and segments is a wheel whatever
      // the server calls it.
      const panel = readBonusPanel({ status: "active", view: { segmentIndex: 0, segments: [3] } });

      assert.equal(panel.kind, "wheel");
    });

    it("drops a malformed segment rather than letting it skew every angle", () => {
      /*
       * Not tidiness. Segment count sets the angle of EVERY wedge, so a
       * non-numeric entry left in place would shift all of them and settle
       * the pointer between two prizes — a wheel that looks fine and points
       * at the wrong thing. Dropping the bad entry keeps the rest correct.
       */
      const panel = readBonusPanel({
        status: "resolved",
        view: { segmentIndex: 0, multiplier: 2, segments: [2, "x", null, 5] },
      });

      assert.deepEqual(panel.kind === "wheel" && panel.segments, [2, 5]);
    });

    it("still resolves normally for a bonus that is not a wheel", () => {
      // The reordering must not make `resolved` unreachable. A pick round
      // that has settled is still a resolved panel, not a wheel.
      const panel = readBonusPanel({ status: "resolved", totalWin: 1960, view: { tileCount: 9 } });

      assert.equal(panel.kind, "resolved");
    });

    it("does not mistake a view carrying only one wheel field for a wheel", () => {
      // Both fields are required. A future module emitting a bare
      // `segmentIndex` should fall through rather than render half a wheel.
      assert.notEqual(readBonusPanel({ status: "active", view: { segmentIndex: 1 } }).kind, "wheel");
      assert.notEqual(readBonusPanel({ status: "active", view: { segments: [1, 2] } }).kind, "wheel");
    });
  });

  describe("free spins", () => {
    const view = { remaining: 7, winMultiplier: 2, accumulatedWin: 850, retriggers: 1 };

    it("is recognised by its shape, not by a module id", () => {
      // No `moduleId` anywhere in this input. A client that needed one
      // would hold a second copy of the engine's module list.
      const panel = readBonusPanel({ status: "active", view });
      assert.equal(panel.kind, "freeSpins");
    });

    it("carries every figure the player is owed an explanation of", () => {
      const panel = readBonusPanel({ status: "active", view });
      assert.deepEqual(panel, {
        kind: "freeSpins",
        remaining: 7,
        multiplier: 2,
        accumulatedMinor: 850,
        retriggers: 1,
        canSpin: true,
      });
    });

    it("defaults the multiplier to 1 rather than 0", () => {
      // A missing multiplier meaning "no multiplier" is 1. Defaulting to 0
      // would display a feature that multiplies every win to nothing.
      const panel = readBonusPanel({ status: "active", view: { remaining: 3 } });
      assert.equal(panel.kind === "freeSpins" && panel.multiplier, 1);
    });

    it("refuses a spin once none remain", () => {
      // The button would otherwise send a step the server must refuse, and
      // the player would read the refusal as the game being broken.
      const panel = readBonusPanel({ status: "active", view: { remaining: 0 } });
      assert.equal(panel.kind === "freeSpins" && panel.canSpin, false);
    });

    it("survives a malformed figure rather than taking the panel down", () => {
      /**
       * This data crosses a socket. A wrong number renders a wrong panel; an
       * exception renders none — and a player who loses the panel loses
       * access to a bonus they are owed.
       */
      const panel = readBonusPanel({
        status: "active",
        view: { remaining: "three" as unknown as number, winMultiplier: null, accumulatedWin: undefined },
      });
      assert.equal(panel.kind, "freeSpins");
      assert.equal(panel.kind === "freeSpins" && panel.remaining, 0);
      assert.equal(panel.kind === "freeSpins" && panel.multiplier, 1);
    });
  });

  describe("pick", () => {
    it("is recognised by its shape", () => {
      const panel = readBonusPanel({ status: "active", view: { tileCount: 9 } });
      assert.equal(panel.kind, "pick");
    });

    it("builds one tile per configured tile, all hidden at the start", () => {
      const panel = readBonusPanel({ status: "active", view: { tileCount: 3 } });
      assert.equal(panel.kind === "pick" && panel.tiles.length, 3);
      assert.deepEqual(
        panel.kind === "pick" && panel.tiles.map((t) => t.label),
        [HIDDEN_LABEL, HIDDEN_LABEL, HIDDEN_LABEL],
      );
    });

    it("shows a revealed multiplier on its own tile only", () => {
      const panel = readBonusPanel({
        status: "active",
        view: { tileCount: 3, picks: [{ tileIndex: 1, multiplier: 5 }] },
      });

      assert.deepEqual(
        panel.kind === "pick" && panel.tiles.map((t) => t.label),
        [HIDDEN_LABEL, "×5", HIDDEN_LABEL],
      );
    });

    it("distinguishes a blank from an untouched tile", () => {
      /**
       * `multiplier: null` is the blank that ends the round; an absent pick
       * is a tile nobody has touched. Rendering both as "?" would hide the
       * fact that the round is over, and rendering both as blank would tell
       * a player they lost when they have picks left.
       */
      const panel = readBonusPanel({
        status: "active",
        view: { tileCount: 2, picks: [{ tileIndex: 0, multiplier: null }] },
      });

      assert.deepEqual(panel.kind === "pick" && panel.tiles.map((t) => t.label), [BLANK_LABEL, HIDDEN_LABEL]);
    });

    it("marks a picked tile revealed even if it is absent from `revealed`", () => {
      // The two fields can disagree in flight. A tile with a pick recorded
      // against it has been claimed regardless of which list says so, and
      // treating it as fresh invites a duplicate claim.
      const panel = readBonusPanel({
        status: "active",
        view: { tileCount: 2, revealed: [], picks: [{ tileIndex: 0, multiplier: 3 }] },
      });

      assert.equal(panel.kind === "pick" && panel.tiles[0].revealed, true);
    });

    it("marks a tile in `revealed` as revealed even with no pick recorded", () => {
      const panel = readBonusPanel({ status: "active", view: { tileCount: 2, revealed: [1] } });
      assert.equal(panel.kind === "pick" && panel.tiles[1].revealed, true);
    });

    it("reports exhaustion once every tile is revealed", () => {
      // So the panel can say the round is finishing rather than leaving a
      // player clicking a dead grid.
      const panel = readBonusPanel({ status: "active", view: { tileCount: 2, revealed: [0, 1] } });
      assert.equal(panel.kind === "pick" && panel.exhausted, true);
    });

    it("is not exhausted while any tile remains", () => {
      const panel = readBonusPanel({ status: "active", view: { tileCount: 2, revealed: [0] } });
      assert.equal(panel.kind === "pick" && panel.exhausted, false);
    });

    it("is not exhausted when there are no tiles at all", () => {
      // A zero-tile grid is a misconfiguration, not a completed round —
      // reporting it as exhausted would announce a finish that never began.
      const panel = readBonusPanel({ status: "active", view: { tileCount: 0 } });
      assert.equal(panel.kind === "pick" && panel.exhausted, false);
    });

    it("refuses a negative or fractional tile count rather than looping oddly", () => {
      assert.equal(readBonusPanel({ status: "active", view: { tileCount: -5 } }).kind === "pick" ? 0 : -1, 0);
      const fractional = readBonusPanel({ status: "active", view: { tileCount: 3.7 } });
      assert.equal(fractional.kind === "pick" && fractional.tiles.length, 3);
    });
  });

  it("reports a module it cannot draw as unknown, rather than an empty panel", () => {
    /**
     * A module shipped in the engine but not yet drawable here. Reported so
     * the caller can say something honest — an empty overlay the player
     * cannot dismiss is worse than an explanation, because a bonus round
     * blocks the base game until it resolves.
     */
    assert.equal(readBonusPanel({ status: "active", view: { somethingNew: true } }).kind, "unknown");
  });

  it("reports a missing state as unknown rather than throwing", () => {
    assert.equal(readBonusPanel(null).kind, "unknown");
    assert.equal(readBonusPanel(undefined).kind, "unknown");
  });
});

describe("tileClickable", () => {
  const fresh = { index: 0, revealed: false, label: HIDDEN_LABEL };

  it("allows a fresh tile when nothing is in flight", () => {
    assert.equal(tileClickable(fresh, false), true);
  });

  it("refuses a revealed tile", () => {
    assert.equal(tileClickable({ ...fresh, revealed: true }, false), false);
  });

  it("refuses every tile while a step is in flight", () => {
    /**
     * The case `revealed` alone cannot express: between sending a pick and
     * its result arriving, no tile has been revealed yet and none may be
     * clicked. Queuing a second pick is how a player ends up having claimed
     * a tile they never saw the result of.
     */
    assert.equal(tileClickable(fresh, true), false);
  });
});
