import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** Block size and parallelisation — scrypt's standard values. Memory use is
 * roughly `128 * N * r`, so these two are what make `N` meaningful. */
const BLOCK_SIZE = 8;
const PARALLELISATION = 1;

/** Node's default maxmem (32 MB) is below what N=2^15 needs, and it throws
 * rather than degrading, so it is raised explicitly here. */
const MAX_MEM = 128 * 2 ** 16 * BLOCK_SIZE;

/**
 * Password hashing with scrypt from Node's own crypto module.
 *
 * scrypt rather than a bcrypt dependency: it is memory-hard, it is in the
 * standard library, and it keeps one fewer native module in the tree of a
 * service that handles credentials. The stored format is
 * `scrypt$N$salt$hash`, with the cost baked into each record so the
 * parameters can be raised later without invalidating existing passwords.
 */

/** CPU/memory cost. 2^15 keeps a login around 100ms on ordinary hardware —
 * unnoticeable to a human, expensive in bulk to anyone brute-forcing a
 * stolen database. */
const COST = 2 ** 15;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function params(cost: number) {
  return { N: cost, r: BLOCK_SIZE, p: PARALLELISATION, maxmem: MAX_MEM };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, params(COST));
  return `scrypt$${COST}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

/**
 * Always compares in constant time, and never throws on a malformed stored
 * value — a corrupt hash must read as "wrong password", not as a 500 that
 * tells an attacker this particular account exists and is broken.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const cost = Number(parts[1]);
  if (!Number.isInteger(cost) || cost <= 0) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[2], "base64url");
    expected = Buffer.from(parts[3], "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  // The cost comes from the stored record, not the constant above, so
  // raising COST later leaves existing passwords verifiable.
  const derived = await scrypt(password, salt, expected.length, params(cost));
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
