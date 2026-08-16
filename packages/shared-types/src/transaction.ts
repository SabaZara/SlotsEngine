export type TransactionType = "debit" | "credit";
export type TransactionStatus = "pending" | "completed" | "failed" | "voided";

/**
 * One ledger movement. `transactionId` is the idempotency key and is unique
 * per operator — a retry carrying the same id must never move money twice.
 * For round-scoped ops the convention is `${roundId}:debit` /
 * `${roundId}:credit`; for bonus payouts, `${bonusSessionId}:bonus-credit`.
 */
export interface Transaction {
  transactionId: string;
  operatorId: string;
  playerId: string;
  roundId?: string;
  type: TransactionType;
  /** Integer minor units — see money.ts. */
  amount: number;
  /** Integer minor units — see money.ts. */
  balanceAfter: number;
  status: TransactionStatus;
  createdAt: string;
}
