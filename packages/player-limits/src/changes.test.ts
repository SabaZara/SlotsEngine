import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyTighteningsOnly, diffLimits } from "./changes.js";
import type { PlayerLimit } from "./decide.js";

/**
 * Loosening versus tightening.
 *
 * Every assertion here is about which direction a change goes, and getting
 * one backwards is not a crash — it is a protection that silently stops
 * protecting. The case worth staring at is an *absent* ceiling: absent
 * means unlimited, so removing a limit is the largest possible loosening,
 * and a reading that treats absent as zero would let a player clear every
 * protection they have and have it apply instantly.
 *
 * What these cannot establish: that 24 hours is the right delay, or that a
 * given regulator accepts this scheme. Those are compliance questions —
 * see the note on `LOOSENING_DELAY_MS`.
 */

const daily = (fields: Partial<PlayerLimit>): PlayerLimit[] => [{ period: "daily", ...fields }];

describe("classifying a single ceiling", () => {
  it("calls a raised ceiling a loosening", () => {
    const [change] = diffLimits(daily({ maxStake: 1_000 }), daily({ maxStake: 5_000 }));
    assert.equal(change?.kind, "loosening");
    assert.equal(change?.from, 1_000);
    assert.equal(change?.to, 5_000);
  });

  it("calls a lowered ceiling a tightening", () => {
    const [change] = diffLimits(daily({ maxStake: 5_000 }), daily({ maxStake: 1_000 }));
    assert.equal(change?.kind, "tightening");
  });

  it("reports nothing when a ceiling is resubmitted unchanged", () => {
    // A client that re-sends the whole set on every save — which is what
    // the PUT contract asks for — must not trip the delay by doing so.
    assert.deepEqual(diffLimits(daily({ maxStake: 1_000 }), daily({ maxStake: 1_000 })), []);
  });
});

describe("an absent ceiling means unlimited", () => {
  it("treats removing a limit as a loosening, not as tightening to zero", () => {
    // The misreading that would matter most. `undefined` compared as `0`
    // makes clearing every protection look like the safest possible
    // change, and it would apply immediately.
    const [change] = diffLimits(daily({ maxStake: 1_000 }), daily({}));
    assert.equal(change?.kind, "loosening", "removing a ceiling opens it to unlimited");
    assert.equal(change?.to, undefined);
  });

  it("treats dropping the period entirely as a loosening too", () => {
    // The same removal expressed a different way. A client can clear a
    // limit either by omitting the field or by omitting the whole period,
    // and both must be read as what they are.
    const [change] = diffLimits(daily({ maxStake: 1_000 }), []);
    assert.equal(change?.kind, "loosening");
  });

  it("treats adding a first-ever limit as a tightening, so it applies at once", () => {
    // A player who has never set a limit and now sets one is protecting
    // themselves. Delaying that by a day would be the control working
    // against the person it exists for.
    const [change] = diffLimits([], daily({ maxLoss: 2_000 }));
    assert.equal(change?.kind, "tightening");
    assert.equal(change?.from, undefined);
    assert.equal(change?.to, 2_000);
  });
});

describe("a submission touching several things", () => {
  it("reports each field separately, so one call can do both", () => {
    // Lowering the daily limit while raising the monthly one is a
    // reasonable thing to do in one save. Judging the request as a whole
    // would force a choice between refusing a tightening and fast-tracking
    // a loosening.
    const changes = diffLimits(
      [{ period: "daily", maxStake: 5_000 }, { period: "monthly", maxLoss: 10_000 }],
      [{ period: "daily", maxStake: 1_000 }, { period: "monthly", maxLoss: 50_000 }],
    );

    assert.equal(changes.length, 2);
    assert.equal(changes.find((c) => c.period === "daily")?.kind, "tightening");
    assert.equal(changes.find((c) => c.period === "monthly")?.kind, "loosening");
  });

  it("distinguishes the two ceilings on one period", () => {
    const changes = diffLimits(
      daily({ maxStake: 5_000, maxLoss: 5_000 }),
      daily({ maxStake: 1_000, maxLoss: 9_000 }),
    );

    assert.equal(changes.find((c) => c.field === "maxStake")?.kind, "tightening");
    assert.equal(changes.find((c) => c.field === "maxLoss")?.kind, "loosening");
  });
});

describe("what may take effect immediately", () => {
  it("applies the tightening and holds the loosening back", () => {
    const current: PlayerLimit[] = [
      { period: "daily", maxStake: 5_000 },
      { period: "monthly", maxLoss: 10_000 },
    ];
    const proposed: PlayerLimit[] = [
      { period: "daily", maxStake: 1_000 },
      { period: "monthly", maxLoss: 50_000 },
    ];

    assert.deepEqual(applyTighteningsOnly(current, proposed), [
      { period: "daily", maxStake: 1_000 },
      { period: "monthly", maxLoss: 10_000 },
    ]);
  });

  it("keeps a limit the proposal dropped, because dropping it is a loosening", () => {
    // The reason this is built from the current state rather than from the
    // proposal. Rebuilding from the proposal would honour the omission
    // instantly, which is the removal path arriving through the back door.
    const current: PlayerLimit[] = [{ period: "daily", maxStake: 1_000 }];

    assert.deepEqual(applyTighteningsOnly(current, []), [{ period: "daily", maxStake: 1_000 }]);
  });

  it("adds a brand-new limit, since having one is tighter than having none", () => {
    assert.deepEqual(applyTighteningsOnly([], [{ period: "weekly", maxLoss: 3_000 }]), [
      { period: "weekly", maxLoss: 3_000 },
    ]);
  });

  it("tightens one field without disturbing the other on the same period", () => {
    const current: PlayerLimit[] = [{ period: "daily", maxStake: 5_000, maxLoss: 5_000 }];
    const proposed: PlayerLimit[] = [{ period: "daily", maxStake: 1_000, maxLoss: 9_000 }];

    assert.deepEqual(applyTighteningsOnly(current, proposed), [
      { period: "daily", maxStake: 1_000, maxLoss: 5_000 },
    ]);
  });

  it("returns periods in a stable order, whatever order they were sent in", () => {
    // So two audit records of the same limits compare equal, and a diff
    // shows a real change rather than a reordering.
    const proposed: PlayerLimit[] = [
      { period: "monthly", maxStake: 100 },
      { period: "daily", maxStake: 100 },
      { period: "weekly", maxStake: 100 },
    ];

    assert.deepEqual(
      applyTighteningsOnly([], proposed).map((limit) => limit.period),
      ["daily", "weekly", "monthly"],
    );
  });

  it("does not mutate the limits it was given", () => {
    // The caller still holds the stored document and the request body, and
    // both are used afterwards to build the audit record.
    const current: PlayerLimit[] = [{ period: "daily", maxStake: 5_000 }];
    applyTighteningsOnly(current, [{ period: "daily", maxStake: 1_000 }]);
    assert.deepEqual(current, [{ period: "daily", maxStake: 5_000 }]);
  });
});
