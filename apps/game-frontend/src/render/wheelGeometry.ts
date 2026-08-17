/**
 * The numbers behind a wheel reveal.
 *
 * Split from the drawing for the reason `spinMotion.ts` and `symbolStyle.ts`
 * are: **anything that can be numerically wrong lives outside the renderer**,
 * because a rotation landing one segment off looks entirely plausible on
 * screen and is only catchable by arithmetic.
 *
 * That risk is not hypothetical here. The wheel is the one bonus whose
 * animation makes a *claim about the outcome*: it points at a segment, and
 * the player reads the prize off where it stops. A reveal that settles on the
 * wrong wedge tells the player they won something other than what the server
 * paid — the money is right and the screen lies about it, which is worse than
 * an obviously broken animation because nobody reports it.
 *
 * **The artist contract**, adapted from the reference's `wheelAngleMath.ts`
 * and worth restating wherever this is drawn: segment 0's centre sits at 12
 * o'clock when the wheel is unrotated, segments run clockwise from there, and
 * the pointer is fixed at 12 o'clock and never itself rotates.
 */

/** Full turns added before settling, purely for the flourish. */
export const DEFAULT_EXTRA_TURNS = 5;

/**
 * Where the wheel must end up for `segmentIndex` to sit under the pointer.
 *
 * Returned in radians, and **negative** for every segment past 0 — rotating
 * the face backwards is what brings a segment clockwise of 12 o'clock up to
 * it. The extra turns are added as positive full rotations, so the net value
 * is normally positive; the sign is only surprising when `extraTurns` is 0.
 */
export function wheelFinalRotation(segmentIndex: number, totalSegments: number, extraTurns = DEFAULT_EXTRA_TURNS): number {
  // A wheel with no segments cannot be pointed at. Guarded rather than
  // allowed to divide by zero, which would yield NaN and freeze the reveal
  // at rotation NaN — a stuck wheel rather than a wrong one, but stuck all
  // the same.
  if (!Number.isFinite(totalSegments) || totalSegments < 1) return 0;
  if (!Number.isFinite(segmentIndex)) return 0;

  const anglePerSegment = (2 * Math.PI) / totalSegments;
  // Wrapped, so an index past the end of the table lands somewhere real
  // rather than spinning off. The server should never send one; a client
  // that copes is cheaper than one that breaks on a server bug.
  const wrapped = ((segmentIndex % totalSegments) + totalSegments) % totalSegments;
  return extraTurns * 2 * Math.PI - wrapped * anglePerSegment;
}

/**
 * Which segment currently sits under the pointer, for a given rotation.
 *
 * The inverse of `wheelFinalRotation`, and it exists to be *tested against*
 * it rather than to be called in anger: a reveal is correct exactly when
 * feeding its final rotation back through here returns the segment the
 * server chose. Asserting that round trip is what catches an off-by-one in
 * the direction convention, which reading either function alone will not.
 */
export function segmentUnderPointer(rotation: number, totalSegments: number): number {
  if (!Number.isFinite(totalSegments) || totalSegments < 1) return 0;
  if (!Number.isFinite(rotation)) return 0;

  const anglePerSegment = (2 * Math.PI) / totalSegments;
  // Rotation is applied to the face, so the segment under a fixed pointer is
  // found by rotating *back*. Normalised into [0, 2pi) first because the
  // value carries whole extra turns.
  const normalised = ((-rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(normalised / anglePerSegment) % totalSegments;
}

/**
 * Eased progress of the spin, 0 to 1.
 *
 * A quintic ease-out rather than the cubic used for the reel settle: a wheel
 * travels several full turns where a reel travels a few rows, so it needs a
 * far more aggressive decay to read as "spinning fast, then hunting for its
 * segment" instead of drifting to a halt.
 *
 * **Deliberately non-overshooting.** An `easeOutBack` would look livelier and
 * would carry the wheel *past* its segment before settling back — which, on
 * the one animation that asserts an outcome, briefly shows the player a prize
 * they did not win. `winCountUp.ts` records the same decision for the same
 * reason on the money path.
 */
export function wheelSpinProgress(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  const t = elapsedMs / durationMs;
  return 1 - (1 - t) ** 5;
}

/**
 * The wheel's rotation at a moment in the reveal.
 *
 * Clamped to the final rotation at the end rather than merely approaching it,
 * because "close enough" on the last frame is what leaves a wheel resting a
 * fraction off its segment — invisible on a 12-segment wheel and obvious on a
 * 3-segment one.
 */
export function wheelRotationAt(elapsedMs: number, finalRotation: number, durationMs: number): number {
  if (!Number.isFinite(finalRotation)) return 0;
  return finalRotation * wheelSpinProgress(elapsedMs, durationMs);
}
