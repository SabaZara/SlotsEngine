import type { FastifyInstance } from "fastify";
import type { Db, MongoClient } from "mongodb";
import {
  InsufficientFundsError,
  creditWithinSession,
  debitWithinSession,
  getBalance,
  withLedgerTransaction,
} from "@slots-engine/ledger";

interface CashBody {
  transactionId?: string;
  playerId?: string;
  amount?: number;
}

/** How many statement rows one call may return. A statement is a paging
 * problem, not a dump; the cap is here so a large operator cannot make this
 * route stream an unbounded result set.
 *
 * Exported so `docs/INTEGRATION.md` can be checked against it — an
 * integrator paging on a documented limit that no longer matches the code
 * silently misses rows. */
export const TRANSACTION_PAGE_LIMIT = 200;

/**
 * Validates the shape of a cash movement before any money is touched.
 *
 * `Number.isInteger` is the line that matters. **Money is always integer
 * minor units in this codebase** — never a float, anywhere — and while
 * `applyLedgerOp` would also refuse a fractional amount, it does so by
 * throwing, which reaches the operator as a 500. A caller who sent `10.5`
 * has made an ordinary mistake and deserves a 400 telling them so.
 *
 * The `> 0` check is separate from integrality on purpose: a negative
 * cash-in would otherwise be a debit wearing the wrong route's name, and a
 * negative cash-out a credit. Direction belongs to the endpoint, not to the
 * sign of the amount.
 */
function isValidCashBody(body: CashBody | undefined): body is Required<Pick<CashBody, "transactionId" | "playerId" | "amount">> {
  return (
    !!body &&
    typeof body.transactionId === "string" &&
    body.transactionId.length > 0 &&
    typeof body.playerId === "string" &&
    body.playerId.length > 0 &&
    typeof body.amount === "number" &&
    Number.isInteger(body.amount) &&
    body.amount > 0
  );
}

/**
 * The four wallet operations a direct-integration operator calls.
 *
 * Every one takes `operatorId` from `request.operatorId` — set only by the
 * auth hook, from a verified signature. None of them accept an operator
 * identifier as input, which is what stops one operator reading or moving
 * another's money.
 */
export function registerWalletRoutes(app: FastifyInstance, db: Db, client: MongoClient): void {
  app.post<{ Body: CashBody }>("/v1/wallet/cash-in", async (request, reply) => {
    if (!isValidCashBody(request.body)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const operatorId = request.operatorId!;
    const { transactionId, playerId, amount } = request.body;

    // No `ensurePlayer` call: the credit's own upsert creates the player
    // with exactly the credited amount as their balance, which is what a
    // first cash-in should produce. Calling it first would be a redundant
    // round trip, not a correction.
    //
    // Note this deliberately does NOT go through `INITIAL_PLAYER_BALANCE`.
    // That default exists for a player arriving through a launch; a player
    // arriving through a cash-in has been given a specific amount by their
    // operator, and adding a starting balance on top would be free money.
    const result = await withLedgerTransaction(client, (session) =>
      creditWithinSession(db, session, { operatorId, playerId, transactionId, amount }),
    );

    // `alreadyProcessed` is returned rather than hidden because a retrying
    // caller needs to distinguish "your retry was absorbed" from "this
    // credited a second time" — and the whole point of the idempotency key
    // is that they can retry without knowing which happened.
    return reply.send({ transactionId, balance: result.balanceAfter, alreadyProcessed: result.alreadyProcessed });
  });

  app.post<{ Body: CashBody }>("/v1/wallet/cash-out", async (request, reply) => {
    if (!isValidCashBody(request.body)) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const operatorId = request.operatorId!;
    const { transactionId, playerId, amount } = request.body;

    try {
      const result = await withLedgerTransaction(client, (session) =>
        debitWithinSession(db, session, { operatorId, playerId, transactionId, amount }),
      );
      return reply.send({ transactionId, balance: result.balanceAfter, alreadyProcessed: result.alreadyProcessed });
    } catch (err) {
      // 402 rather than 400: the request was well-formed and the caller is
      // correctly authenticated. Nothing about it should be *changed* on a
      // retry — only the balance needs to differ — and a 400 would tell
      // them to fix a request that has nothing wrong with it.
      if (err instanceof InsufficientFundsError) {
        return reply.code(402).send({ error: "insufficient_funds" });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { playerId?: string } }>("/v1/wallet/balance", async (request, reply) => {
    const { playerId } = request.query ?? {};
    if (!playerId) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const operatorId = request.operatorId!;

    // An unknown player reads as 0 rather than 404 — `getBalance`'s
    // documented behaviour, and the right answer here: "no player" and "no
    // money" are the same fact to a caller, and a 404 would also confirm
    // whether a given playerId exists under this operator.
    return reply.send({ playerId, balance: await getBalance(db, operatorId, playerId) });
  });

  app.get<{ Querystring: { playerId?: string; roundId?: string } }>("/v1/wallet/transactions", async (request, reply) => {
    const { playerId, roundId } = request.query ?? {};
    if (!playerId && !roundId) {
      return reply.code(400).send({ error: "must_provide_playerId_or_roundId" });
    }
    const operatorId = request.operatorId!;

    // `operatorId` is always in the filter, never optional — it is the
    // tenant boundary. A `roundId` is a UUID and effectively unguessable,
    // but "unguessable" is not an access control, and one omitted field
    // here would expose every operator's statement to every other.
    const filter: Record<string, unknown> = { operatorId };
    if (roundId) filter.roundId = roundId;
    else filter.playerId = playerId;

    const transactions = await db
      .collection("transactions")
      .find(filter, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(TRANSACTION_PAGE_LIMIT)
      .toArray();

    return reply.send({ transactions });
  });
}
