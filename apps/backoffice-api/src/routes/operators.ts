import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import type { IntegrationType, Operator } from "@slots-engine/shared-types";
import { encryptSecret } from "@slots-engine/secrets";
import { requireRole } from "../auth/middleware.js";
import { writeAuditLog } from "../audit/log.js";

/**
 * Issuing an operator credential is the operation that lets an outside
 * company move money through this platform, so it sits with `operations`
 * rather than with `game_designer` — the same role that already holds the
 * other money-adjacent controls. `super_admin` passes everything, as ever.
 */
const CAN_MANAGE_OPERATORS = requireRole("operations");

/**
 * Reading is deliberately wider than writing. Knowing *which* operators
 * exist and what they are entitled to is ordinary operational context —
 * support answering "why can't this partner launch that game" needs it —
 * and the response never carries a secret, so widening it costs nothing.
 */
const CAN_VIEW_OPERATORS = requireRole("operations", "viewer");

/** 32 bytes of entropy, hex-encoded. Long enough that guessing is not a
 * strategy, and hex rather than base64 so it survives being pasted into a
 * config file, a shell variable or a YAML value without escaping. */
const API_SECRET_BYTES = 32;

interface CreateOperatorBody {
  operatorId?: string;
  name?: string;
  integrationType?: IntegrationType;
  enabledGameIds?: string[];
}

interface UpdateOperatorBody {
  name?: string;
  enabledGameIds?: string[];
  disabled?: boolean;
}

/**
 * The shape every route returns — with `apiSecret` removed.
 *
 * This is the second independent layer, not the first: the stored value is
 * already AES-256-GCM ciphertext, so even a route that forgot to redact
 * would leak `enc:…` rather than a usable credential. Both exist because
 * they fail differently — encryption protects the database at rest, this
 * protects against a projection someone forgets to write. The one place a
 * secret is ever returned is the create and rotate responses, where it is
 * the entire point.
 */
function redactSecret(doc: Record<string, unknown>): Omit<Operator, "apiSecret"> {
  const { _id, apiSecret, ...rest } = doc;
  return rest as Omit<Operator, "apiSecret">;
}

function isValidIntegrationType(value: unknown): value is IntegrationType {
  return value === "direct" || value === "reverse";
}

/** Every element must be a string. An array containing an object would
 * otherwise reach the `enabledGameIds` entitlement check, where `includes`
 * compares by reference and would silently never match. */
function isValidGameIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
}

export function registerOperatorRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/operators", { preHandler: [CAN_VIEW_OPERATORS] }, async (_request, reply) => {
    const docs = await db.collection("operators").find({}).sort({ createdAt: -1 }).toArray();
    return reply.send({ operators: docs.map(redactSecret) });
  });

  app.get<{ Params: { operatorId: string } }>(
    "/v1/operators/:operatorId",
    { preHandler: [CAN_VIEW_OPERATORS] },
    async (request, reply) => {
      const doc = await db.collection("operators").findOne({ operatorId: request.params.operatorId });
      if (!doc) return reply.code(404).send({ error: "operator_not_found" });
      return reply.send({ operator: redactSecret(doc) });
    },
  );

  app.post<{ Body: CreateOperatorBody }>("/v1/operators", { preHandler: [CAN_MANAGE_OPERATORS] }, async (request, reply) => {
    const { operatorId, name, integrationType, enabledGameIds } = request.body ?? {};

    if (typeof operatorId !== "string" || !operatorId.trim()) {
      return reply.code(400).send({ error: "operatorId_required" });
    }
    if (typeof name !== "string" || !name.trim()) {
      return reply.code(400).send({ error: "name_required" });
    }
    if (!isValidIntegrationType(integrationType)) {
      return reply.code(400).send({ error: "invalid_integration_type", allowed: ["direct", "reverse"] });
    }
    if (enabledGameIds !== undefined && !isValidGameIdList(enabledGameIds)) {
      return reply.code(400).send({ error: "invalid_enabled_game_ids" });
    }

    // Checked before inserting so the ordinary case gets a clean 409 rather
    // than an 11000 surfacing as a 500. The unique index is still the
    // authority — two simultaneous creates would both pass this check, and
    // the index is what actually decides.
    if (await db.collection("operators").findOne({ operatorId })) {
      return reply.code(409).send({ error: "operator_already_exists" });
    }

    const apiKeyId = randomUUID();
    const apiSecret = randomBytes(API_SECRET_BYTES).toString("hex");

    const operator: Operator = {
      operatorId,
      name,
      integrationType,
      apiKeyId,
      apiSecret,
      enabledGameIds: enabledGameIds ?? [],
      createdAt: new Date().toISOString(),
    };

    try {
      // The plaintext secret is never written. `operator` above holds it
      // only so the response can carry it once; what reaches Mongo is the
      // encrypted form.
      await db.collection("operators").insertOne({ ...operator, apiSecret: encryptSecret(apiSecret) });
    } catch (err) {
      // The race the check above cannot close.
      if ((err as { code?: number }).code === 11000) {
        return reply.code(409).send({ error: "operator_already_exists" });
      }
      throw err;
    }

    await writeAuditLog(
      db,
      {
        actorUserId: request.user!.userId,
        action: "operator.create",
        entityType: "operator",
        entityId: operatorId,
        // `apiKeyId` is recorded because it is the public half and appears
        // in integration-api's logs — being able to tie a key back to the
        // moment it was issued is most of what this record is for. The
        // secret is not recorded, here or anywhere.
        diff: { name, integrationType, apiKeyId, enabledGameIds: operator.enabledGameIds },
      },
      (auditErr) => request.log.error({ err: auditErr }, "failed to audit operator.create"),
    );

    // **The only response that ever carries `apiSecret`.** It cannot be
    // recovered afterwards — the stored copy is encrypted, and no route
    // decrypts it back out to a caller — so the UI has to make clear this
    // is the one chance to copy it. Same shape as every cloud provider's
    // API-key UX, for the same reason: a secret that can be re-read is a
    // secret that leaks from wherever it is re-read.
    return reply.code(201).send({ operator, secretShownOnce: true });
  });

  app.put<{ Params: { operatorId: string }; Body: UpdateOperatorBody }>(
    "/v1/operators/:operatorId",
    { preHandler: [CAN_MANAGE_OPERATORS] },
    async (request, reply) => {
      const { name, enabledGameIds, disabled } = request.body ?? {};

      if (name !== undefined && (typeof name !== "string" || !name.trim())) {
        return reply.code(400).send({ error: "name_required" });
      }
      if (enabledGameIds !== undefined && !isValidGameIdList(enabledGameIds)) {
        return reply.code(400).send({ error: "invalid_enabled_game_ids" });
      }
      if (disabled !== undefined && typeof disabled !== "boolean") {
        return reply.code(400).send({ error: "invalid_request" });
      }

      // `disabledAt` is a timestamp rather than a boolean flag, so the
      // record answers "when was this withdrawn" and not merely "is it".
      // Re-enabling unsets it — `$unset` rather than setting it to null,
      // because integration-api tests truthiness and a null would read as
      // enabled either way, but a field that is absent when it does not
      // apply is the shape the rest of this schema uses.
      const set: Record<string, unknown> = {};
      const unset: Record<string, unknown> = {};
      if (name !== undefined) set.name = name;
      if (enabledGameIds !== undefined) set.enabledGameIds = enabledGameIds;
      if (disabled === true) set.disabledAt = new Date().toISOString();
      if (disabled === false) unset.disabledAt = "";

      if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
        return reply.code(400).send({ error: "nothing_to_update" });
      }

      const result = await db.collection("operators").findOneAndUpdate(
        { operatorId: request.params.operatorId },
        {
          ...(Object.keys(set).length > 0 ? { $set: set } : {}),
          ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        },
        { returnDocument: "after" },
      );
      if (!result) return reply.code(404).send({ error: "operator_not_found" });

      await writeAuditLog(
        db,
        {
          actorUserId: request.user!.userId,
          action: "operator.update",
          entityType: "operator",
          entityId: request.params.operatorId,
          diff: { name, enabledGameIds, disabled },
        },
        (auditErr) => request.log.error({ err: auditErr }, "failed to audit operator.update"),
      );

      return reply.send({ operator: redactSecret(result) });
    },
  );

  /**
   * Rotation, as a separate route from update.
   *
   * Deliberately not a field on `PUT`: rotating invalidates the
   * credential the operator is currently using, so every one of their
   * in-flight requests starts failing the moment this returns. That is a
   * different kind of action from renaming, and it should not be reachable
   * by sending one extra key in an update body. A distinct endpoint makes
   * it distinct in the audit log too.
   */
  app.post<{ Params: { operatorId: string } }>(
    "/v1/operators/:operatorId/rotate-secret",
    { preHandler: [CAN_MANAGE_OPERATORS] },
    async (request, reply) => {
      const apiSecret = randomBytes(API_SECRET_BYTES).toString("hex");
      // The key id is rotated alongside the secret. Keeping it would leave
      // the old identifier valid against a new secret, so a stale client
      // would fail signature verification rather than being told its
      // credential no longer exists — a worse diagnostic for the same
      // outcome.
      const apiKeyId = randomUUID();

      const result = await db
        .collection("operators")
        .findOneAndUpdate(
          { operatorId: request.params.operatorId },
          { $set: { apiKeyId, apiSecret: encryptSecret(apiSecret), secretRotatedAt: new Date().toISOString() } },
          { returnDocument: "after" },
        );
      if (!result) return reply.code(404).send({ error: "operator_not_found" });

      await writeAuditLog(
        db,
        {
          actorUserId: request.user!.userId,
          action: "operator.rotate_secret",
          entityType: "operator",
          entityId: request.params.operatorId,
          diff: { apiKeyId },
        },
        (auditErr) => request.log.error({ err: auditErr }, "failed to audit operator.rotate_secret"),
      );

      // Shown once, exactly as on create.
      return reply.send({ operator: { ...redactSecret(result), apiSecret }, secretShownOnce: true });
    },
  );
}
