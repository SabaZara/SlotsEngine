import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import {
  DEFAULT_CURRENCY,
  DEFAULT_MATH_ENGINE_ID,
  DEFAULT_PAYLINE_WIN_RULE,
  type GameDefinition,
} from "@slots-engine/shared-types";
import type { GameDraft } from "./drafts.js";
import { validateDraft } from "./validateDraft.js";
import { writeAuditLog } from "../audit/log.js";
import { requestSimulation, type SimulationReport } from "./simulateClient.js";

export class PublishBlockedError extends Error {
  constructor(message: string, readonly report?: SimulationReport) {
    super(message);
  }
}

/** Spin count for the official pre-publish run. Large enough for the RTP
 * estimate to settle, small enough to keep a publish interactive. */
export const OFFICIAL_SIM_COUNT = 100_000;

/**
 * How far measured RTP may drift from the declared target before a publish
 * is refused.
 *
 * This is the single most valuable gate in the backoffice. `rtpTarget` is
 * an intention; the simulation is a measurement, and the two disagreeing
 * means the paytable does not do what its author believes. Shipping that is
 * how a game quietly returns 130% and loses money on every spin, or returns
 * 60% and is unplayable — neither of which looks wrong in a config file.
 *
 * The tolerance is generous because a 100k-spin estimate carries real
 * sampling noise on a volatile game; it is meant to catch a
 * misconfiguration, not to police the last percent of tuning.
 */
export const RTP_TOLERANCE = 0.05;

export interface PublishResult {
  gameDef: GameDefinition;
  simulation: SimulationReport;
}

/**
 * Publishing is the only thing that makes draft edits playable.
 *
 * Order matters: validate, simulate, check the result, and only then touch
 * the live `games` document. A publish that fails at any point must leave
 * players on exactly the version they were already playing — so nothing is
 * written until everything that could refuse has already run.
 */
export async function publishDraft(
  db: Db,
  draft: GameDraft,
  actorUserId: string,
  options: { force?: boolean; runSeed?: string } = {},
): Promise<PublishResult> {
  validateDraft(draft);

  const currentPublished = await db.collection("games").findOne({ gameId: draft.gameId });
  const nextVersion = ((currentPublished?.version as number | undefined) ?? 0) + 1;

  const gameDef: GameDefinition = {
    gameId: draft.gameId,
    name: draft.name,
    version: nextVersion,
    status: "published",
    // Presentation only, and the one field here that the RTP gate above
    // deliberately does not consider — artwork cannot change what a game
    // pays. Carried conditionally so a game with no artwork publishes no
    // `assets` key at all: the public projection distinguishes "no artwork"
    // from "artwork that failed to load", and an empty object would publish
    // as the second.
    ...(draft.assets !== undefined ? { assets: draft.assets } : {}),
    ...(draft.theme !== undefined ? { theme: draft.theme } : {}),
    grid: draft.grid,
    reelGenerationMode: draft.reelGenerationMode,
    ...(draft.reelStrips !== undefined ? { reelStrips: draft.reelStrips } : {}),
    ...(draft.symbolWeights !== undefined ? { symbolWeights: draft.symbolWeights } : {}),
    paylines: draft.paylines,
    symbols: draft.symbols,
    bonusModules: draft.bonusModules,
    rtpTarget: draft.rtpTarget,
    betOptions: draft.betOptions,
    currency: draft.currency ?? DEFAULT_CURRENCY,
    mathEngineId: draft.mathEngineId ?? DEFAULT_MATH_ENGINE_ID,
    paylineWinRule: draft.paylineWinRule ?? DEFAULT_PAYLINE_WIN_RULE,
    publishedAt: new Date().toISOString(),
    publishedByUserId: actorUserId,
  };

  // The lowest configured bet, so results stay comparable across publishes
  // however betOptions is later reordered.
  //
  // `runSeed` is optional and production never passes it: a real publish
  // must draw a fresh sample, or the gate would be checking the same 100k
  // spins forever and a paytable change could pass on a seed that happened
  // to flatter it. `requestSimulation` generates one and records it on the
  // report either way, which is what makes a verdict reproducible.
  //
  // Tests pass it for the opposite reason. An unseeded run is an independent
  // sample, and measured drift on the tuned reference draft ranges
  // 0.007–0.037 against a 0.05 tolerance — comfortable, but only ~1.4 sd of
  // headroom against ~0.02 sampling noise, so a test that publishes and then
  // asserts on the result is rarely but genuinely flaky. Pinning the seed
  // removes the sampling from tests whose subject is not the sampling.
  const simulation = await requestSimulation(
    gameDef,
    OFFICIAL_SIM_COUNT,
    Math.min(...draft.betOptions),
    options.runSeed,
  );

  const drift = Math.abs(simulation.resultRtp - draft.rtpTarget);
  if (drift > RTP_TOLERANCE && !options.force) {
    // Refused, not warned. A warning in an admin UI is a warning someone
    // clicks past at 6pm on a Friday.
    throw new PublishBlockedError(
      `measured RTP ${simulation.resultRtp.toFixed(4)} differs from target ${draft.rtpTarget} by ${drift.toFixed(4)}, ` +
        `more than the ${RTP_TOLERANCE} tolerance — check the paytable, or publish with force to override deliberately`,
      simulation,
    );
  }

  await db.collection("rtpSimulationRuns").insertOne({
    runId: randomUUID(),
    gameId: draft.gameId,
    gameVersion: nextVersion,
    ...simulation,
    createdAt: new Date(),
  });

  // The append-only snapshot goes in FIRST. A round records the
  // `gameVersion` it ran under, so a live game whose version has no
  // corresponding snapshot would be unauditable — whereas a snapshot with
  // no live game is merely unused. If only one of these two writes can
  // survive a crash, this is the one that must.
  await db.collection("gameVersions").insertOne({ ...gameDef });
  /*
   * `replaceOne`, not `$set`. F25's second site, and the one with the worse
   * consequence — found by clearing artwork on the live stack and watching
   * players keep receiving it.
   *
   * `$set` writes the keys it is given and leaves every other key in the
   * existing document untouched, so any optional field dropped between two
   * publishes survived on the live game forever: v6 published without
   * artwork, `gameVersions` recorded v6 without artwork, and `games` went
   * on serving v5's. The append-only snapshot and the document players
   * actually read had **diverged**, which makes the audit trail wrong about
   * the thing it exists to establish — what a round was played under.
   *
   * A published game *is* its `gameDef`; there is no field on the live
   * document that legitimately outlives a publish. Replacing states that,
   * and makes the two writes above produce identical content by
   * construction rather than by both being spelled correctly.
   */
  await db.collection("games").replaceOne({ gameId: draft.gameId }, { ...gameDef }, { upsert: true });

  await writeAuditLog(db, {
    actorUserId,
    action: "game.publish",
    entityType: "game",
    entityId: draft.gameId,
    diff: {
      fromVersion: (currentPublished?.version as number | undefined) ?? null,
      toVersion: nextVersion,
      resultRtp: simulation.resultRtp,
      rtpTarget: draft.rtpTarget,
      // Recorded so the decision is reproducible from the audit trail alone.
      // "Measured RTP 0.9580" is only checkable later if the run that
      // produced it can be repeated exactly.
      runSeed: simulation.runSeed,
      // And how much of that figure was measured rather than assumed — see
      // docs/TODO.md item G.
      estimatedBonusShare: simulation.confidence.estimatedShare,
      // Whether that estimated share was DERIVED from the module's own
      // configured payouts or fell back to a flat constant. The share alone
      // does not say: 7% resting on arithmetic over the real reward table
      // and 7% resting on a guess are the same number and very different
      // evidence. An auditor reading this record years later cannot be
      // expected to know which modules supported derivation on the day it
      // was written, so the record says.
      bonusReturnSource: simulation.confidence.bonusReturnSource,
      bonusReturnMultiplier: simulation.confidence.assumedBonusReturnMultiplier,
      ...(options.force && drift > RTP_TOLERANCE ? { forcedPastRtpTolerance: true } : {}),
    },
  });

  return { gameDef, simulation };
}
