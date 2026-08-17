import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import type { Logger } from "@slots-engine/logging";
import { canonicalRequest, verifySignature } from "./hmac.js";
import { OperatorSecretNotEncryptedError, findOperatorByKeyId } from "./operators.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set only by this hook, only after a signature verifies. Never read
     * from a request body or query — see the note at the assignment. */
    operatorId?: string;
    rawBody?: string;
  }
}

/**
 * How far a request's timestamp may be from ours.
 *
 * Bounds the window in which a captured request is even considered, so the
 * nonce collection only has to remember a few minutes rather than forever.
 * Five minutes is generous for clock drift on a correctly-configured server
 * and short enough that the replay table stays small.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

/** Margin on top of the skew window before a recorded signature is reaped.
 * Nothing needs remembering past the point the timestamp check would refuse
 * the request anyway; the margin only covers clock movement between the two
 * checks. */
const NONCE_RETENTION_MARGIN_MS = 60_000;

/**
 * Records a signature and reports whether this is the first time it has
 * been seen.
 *
 * An `insertOne` that treats 11000 as "seen before", not a find-then-insert:
 * two concurrent replays would both find nothing and both proceed, which is
 * precisely the race an attacker replaying in parallel would exploit. The
 * unique index is the mechanism — the house idiom throughout this codebase.
 */
async function isFirstUseOfSignature(db: Db, operatorId: string, signature: string): Promise<boolean> {
  try {
    await db.collection("usedRequestSignatures").insertOne({
      operatorId,
      signature,
      expireAt: new Date(Date.now() + MAX_SKEW_MS + NONCE_RETENTION_MARGIN_MS),
    });
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

export interface AuthHookOptions {
  db: Db;
  logger: Logger;
  /** Paths that skip authentication entirely. Health only — see below. */
  publicPaths?: string[];
}

/**
 * HMAC authentication for every operator-facing route.
 *
 * The order of checks is deliberate and runs cheapest-first, but one
 * ordering choice is a security decision rather than a performance one:
 * **the nonce is recorded only after the signature verifies.** Recording it
 * earlier would let anyone burn a legitimate operator's request signature by
 * replaying it with a corrupted body — the first (invalid) copy would claim
 * the nonce and the real request would then be refused as a replay. An
 * unverified request must not be able to affect state at all.
 */
export function registerAuthHook(app: FastifyInstance, options: AuthHookOptions): void {
  const { db, logger, publicPaths = ["/health"] } = options;

  app.addHook("preHandler", async (request, reply) => {
    // Compared against the path only. `request.url` carries the query
    // string, so matching on it would mean `/health?x=1` is public and
    // `/v1/wallet/balance` could never be — and, worse, a crafted
    // `/v1/wallet/balance?/health` style path would be worth checking. The
    // routerPath-free form here is the plain pathname.
    const path = request.url.split("?")[0] ?? "";
    if (publicPaths.includes(path)) return;

    const apiKeyId = request.headers["x-api-key-id"];
    const timestamp = request.headers["x-timestamp"];
    const signature = request.headers["x-signature"];

    if (typeof apiKeyId !== "string" || typeof timestamp !== "string" || typeof signature !== "string") {
      return reply.code(401).send({ error: "missing_auth_headers" });
    }

    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_SKEW_MS) {
      return reply.code(401).send({ error: "timestamp_out_of_range" });
    }

    let operator;
    try {
      operator = await findOperatorByKeyId(db, apiKeyId);
    } catch (err) {
      if (err instanceof OperatorSecretNotEncryptedError) {
        // A configuration fault on our side, but from the operator's
        // position their credential does not work — so it is a 401 to them
        // and an error in our logs, rather than a 500 that tells an
        // outsider something went wrong internally.
        logger.error({ err, apiKeyId }, "operator credential is not usable");
        return reply.code(401).send({ error: "unknown_api_key" });
      }
      throw err;
    }

    // Deliberately the same response as a bad signature would eventually
    // produce, and deliberately not "no such operator": distinguishing the
    // two lets anyone enumerate valid apiKeyIds by watching which ones
    // change the error. The timing still differs slightly (an unknown key
    // skips the HMAC computation), which is a known and accepted
    // limitation — closing it would mean computing a signature against a
    // dummy secret, and the information it leaks is a key identifier that
    // travels in cleartext headers anyway.
    if (!operator) {
      return reply.code(401).send({ error: "unknown_api_key" });
    }

    if (operator.disabledAt) {
      // Distinguished from `unknown_api_key` on purpose. This one is only
      // reachable by someone holding a valid credential, so it leaks
      // nothing to a prober, and "your access was withdrawn" is genuinely
      // different information from "your credential is wrong" for the
      // operator trying to work out why their integration stopped.
      return reply.code(403).send({ error: "operator_disabled" });
    }

    const canonical = canonicalRequest(timestamp, request.method, request.url, request.rawBody ?? "");
    if (!verifySignature(operator.apiSecret, canonical, signature)) {
      return reply.code(401).send({ error: "bad_signature" });
    }

    if (!(await isFirstUseOfSignature(db, operator.operatorId, signature))) {
      return reply.code(401).send({ error: "replayed_request" });
    }

    // **The property this whole file exists to establish.** `operatorId`
    // comes only from a verified signature, never from the request body or
    // query — otherwise any operator holding valid credentials could name a
    // different `operatorId` and read or move another operator's money.
    // Every route below reads `request.operatorId` and none of them accept
    // an operator identifier as input; that is the invariant, and the
    // socket's equivalent test ("a client can name a bet, never a player")
    // is the same idea one layer in.
    request.operatorId = operator.operatorId;
  });
}
