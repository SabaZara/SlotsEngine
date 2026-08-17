import { REMOVABLE_DRAFT_FIELDS } from "@slots-engine/shared-types";
import type {
  BonusModuleConfig,
  GameAssets,
  GameTheme,
  GridSize,
  PaylinePath,
  PaylineWinRule,
  ReelGenerationMode,
  ReelStrip,
  RoleId,
  SymbolRule,
  SymbolWeight,
} from "@slots-engine/shared-types";
import type { BonusParamSpec } from "./gameBuilder/BonusParamsForm.js";

/**
 * `import.meta.env` is injected by Vite and is undefined anywhere else, so
 * reading a property off it throws outside a bundle — which made this module
 * unimportable from a test. Guarded rather than worked around in the test,
 * because a module that can only be loaded by one toolchain is the reason
 * this file had no tests at all.
 */
const BASE_URL = import.meta.env?.VITE_BACKOFFICE_API_URL ?? "http://localhost:9105";

/** Mirrors the API's `GameDraft`. Deliberately has no `version` or `status`:
 * those are facts about a *publish*, not an edit, so the editor cannot
 * express a change to them. */
export interface GameDraft {
  gameId: string;
  name: string;
  /** Artwork. Presentation only — see `GameAssets`. Optional at every level,
   * and absent for every game this repo ships. */
  assets?: GameAssets;
  /** Colour identity. Presentation only. */
  theme?: GameTheme;
  grid: GridSize;
  reelGenerationMode: ReelGenerationMode;
  reelStrips?: ReelStrip[];
  symbolWeights?: SymbolWeight[][];
  paylines: PaylinePath[];
  symbols: SymbolRule[];
  bonusModules: BonusModuleConfig[];
  rtpTarget: number;
  betOptions: number[];
  currency?: string;
  mathEngineId?: string;
  paylineWinRule?: PaylineWinRule;
  updatedAt: string;
  updatedByUserId: string;
}

export interface SimulationReport {
  simCount: number;
  betPerSpin: number;
  resultRtp: number;
  baseRtp: number;
  bonusRtp: number;
  hitFrequency: number;
  bonusFrequency: number;
  volatilityIndex: number;
  maxWinMultiplier: number;
  generatedAt: string;
}

export interface GameListEntry {
  gameId: string;
  name: string;
  publishedVersion: number | null;
  hasDraft: boolean;
  draftUpdatedAt: string | null;
}

export interface AuditEntry {
  entryId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  diff?: Record<string, unknown>;
  timestamp: string;
}

export interface SessionUser {
  userId: string;
  email: string;
  roles: RoleId[];
  active: boolean;
}

export interface ManagedUser extends SessionUser {
  createdAt: string;
  lastLoginAt?: string;
}

/**
 * An operator as every read returns it — **without `apiSecret`**.
 *
 * The omission is enforced by the type rather than left to discipline: the
 * create and rotate calls intersect this with `{ apiSecret: string }`, so a
 * screen that tries to read a secret off a listed operator fails to
 * compile. That matters because the mistake it prevents — building a UI
 * that displays a secret it can fetch on demand — would be a redesign to
 * undo, not a patch.
 */
export interface ReportQuery {
  operatorId?: string;
  playerId?: string;
  from?: string;
  to?: string;
  format?: string;
}

/** One ledger movement as a report returns it. `amount` and `balanceAfter`
 * are integer minor units, like every money value in this system. */
export interface ReportTransaction {
  transactionId: string;
  operatorId: string;
  playerId: string;
  roundId?: string;
  type: "debit" | "credit";
  amount: number;
  balanceAfter: number;
  status: string;
  createdAt: string;
}

export interface ReportPage {
  transactions: ReportTransaction[];
  count: number;
  hasMore: boolean;
  /** Present only when there is another page — see the route's note on why
   * a caller loops on its presence rather than comparing counts. */
  nextCursor?: string;
}

export interface ReportSummary {
  staked: number;
  paidOut: number;
  net: number;
  debitCount: number;
  creditCount: number;
}

export interface SupportLookup {
  player: { operatorId: string; playerId: string; balance: number };
  recentTransactions: ReportTransaction[];
  recentRounds: Array<{
    roundId: string;
    gameId: string;
    gameVersion: number;
    totalBet: number;
    seed: string;
    rngAlgorithm: string;
    status: string;
    createdAt: string;
  }>;
  /** What this player may stake or lose per period. Empty means unlimited.
   * Amounts are integer minor units, like every money value here. */
  limits: Array<{ period: string; maxStake?: number; maxLoss?: number }>;
  /** What they have actually staked and won, per period counter. */
  limitUsage: Array<{ period: string; periodKey: string; staked: number; won: number }>;
  truncated: { transactions: boolean; rounds: boolean };
  limit: number;
}

/** Builds a query string, omitting anything empty — an empty `from=` would
 * otherwise reach the server as a value to parse rather than as an absent
 * filter. */
function reportQueryString(params: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const rendered = query.toString();
  return rendered ? `?${rendered}` : "";
}

export interface ManagedOperator {
  operatorId: string;
  name: string;
  integrationType: "direct" | "reverse";
  apiKeyId: string;
  enabledGameIds: string[];
  createdAt: string;
  disabledAt?: string;
  secretRotatedAt?: string;
}

/**
 * A failed request, carrying the server's own error code so a screen can
 * react to *what* went wrong rather than parsing prose. `rtp_out_of_tolerance`
 * in particular is a refusal a designer must be able to act on, not a
 * generic failure.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The session token lives in memory only, never in localStorage.
 *
 * A bearer token in storage is readable by any script that ends up on the
 * page, and it survives the tab — so a shared machine keeps an admin session
 * alive long after the person walked away. The cost is re-logging-in after a
 * refresh, which for an internal tool is the right side of that trade.
 */
let sessionToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

/** Registered once by the app root so any 401 anywhere returns the user to
 * the login screen, rather than each screen having to handle it. */
export function setSessionLostHandler(handler: () => void): void {
  onSessionLost = handler;
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
    },
    // Always a body when one is expected, even an empty object: the API
    // tolerates an absent body, but sending `{}` keeps every call uniform.
    ...(options.method && options.method !== "GET" ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    // A revoked or expired session is not a screen-level error — the user
    // has to log in again, and every screen would otherwise reimplement
    // that redirect.
    if (response.status === 401 && sessionToken) {
      sessionToken = null;
      onSessionLost?.();
    }
    throw new ApiError(
      response.status,
      (payload.error as string) ?? "request_failed",
      (payload.message as string) ?? (payload.error as string) ?? `request failed (${response.status})`,
      payload,
    );
  }

  return payload as T;
}

/**
 * Turns a removed field into an explicit `null` the server can act on.
 *
 * **Found by driving the live stack, and invisible to every test that did
 * not.** `JSON.stringify({assets: undefined})` is `{}`, so "clear this
 * field" and "do not touch this field" left the browser as the same bytes.
 * The API merges a patch over the stored draft, so the second reading is the
 * one it took: artwork could be added and then never cleared. The editor
 * behaved correctly — its clear-the-last-symbol path returns `undefined`,
 * pinned by its own tests — and the field came back on the next reload
 * anyway, because the removal never reached the wire.
 *
 * Only keys **present** on the patch are converted, which is what keeps a
 * one-field save from clearing the rest of the draft: `{name: "x"}` still
 * says nothing at all about `assets`.
 */
export function withExplicitRemovals(patch: Partial<GameDraft>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...patch };
  for (const field of REMOVABLE_DRAFT_FIELDS) {
    if (field in patch && patch[field] === undefined) body[field] = null;
  }
  return body;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; expiresAt: number; user: SessionUser }>("/v1/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  me: () => request<{ user: SessionUser }>("/v1/auth/me"),

  logout: () => request<{ loggedOut: boolean }>("/v1/auth/logout", { method: "POST" }),

  listGames: () => request<{ games: GameListEntry[] }>("/v1/games"),

  /** The bonus modules this build can play, read from the engine registry.
   * Fetched rather than hardcoded here because a client-side copy drifted the
   * moment a third module shipped — see the route's own comment. */
  listBonusModules: () =>
    request<{ modules: string[]; schemas?: Array<{ moduleId: string; params: BonusParamSpec[] }> }>("/v1/bonus-modules"),

  createGame: (gameId: string, name: string) =>
    request<{ draft: GameDraft }>("/v1/games", { method: "POST", body: { gameId, name } }),

  getGame: (gameId: string) =>
    request<{ draft: GameDraft | null; published: (GameDraft & { version: number }) | null }>(
      `/v1/games/${encodeURIComponent(gameId)}`,
    ),

  draftFromPublished: (gameId: string) =>
    request<{ draft: GameDraft }>(`/v1/games/${encodeURIComponent(gameId)}/draft-from-published`, { method: "POST" }),

  /** Returns the saved draft plus live validation. A draft saves even when
   * invalid — validity is a publish-time gate, so the errors are advisory
   * here and blocking only at publish. */
  saveDraft: (gameId: string, patch: Partial<GameDraft>) =>
    request<{ draft: GameDraft; valid: boolean; errors: string[] }>(`/v1/games/${encodeURIComponent(gameId)}`, {
      method: "PUT",
      body: withExplicitRemovals(patch),
    }),

  /**
   * Uploads one asset and returns the draft with a signed URL for display.
   *
   * A separate route from `saveDraft` on purpose, and the separation is the
   * feature rather than tidiness: the draft PUT refuses `assets` outright,
   * because assets are stored as keys and shown as signed URLs — so a save
   * that echoed the displayed value back would overwrite the key with a
   * URL. That is the bug the reference repo shipped, compounding once per
   * save. See `keys.ts` in `@slots-engine/asset-storage`.
   */
  uploadAsset: (gameId: string, upload: { slot: string; symbol?: string; contentType: string; data: string }) =>
    request<{ key: string; url: string; draft: GameDraft }>(`/v1/games/${encodeURIComponent(gameId)}/assets`, {
      method: "POST",
      body: upload,
    }),

  clearAsset: (gameId: string, slot: string, symbol?: string) =>
    request<{ draft: GameDraft }>(
      `/v1/games/${encodeURIComponent(gameId)}/assets?slot=${encodeURIComponent(slot)}` +
        (symbol ? `&symbol=${encodeURIComponent(symbol)}` : ""),
      { method: "DELETE" },
    ),

  simulate: (gameId: string, simCount: number) =>
    request<{ simulation: SimulationReport }>(`/v1/games/${encodeURIComponent(gameId)}/simulate`, {
      method: "POST",
      body: { simCount },
    }),

  publish: (gameId: string, force = false) =>
    request<{ gameDef: GameDraft & { version: number }; simulation: SimulationReport }>(
      `/v1/games/${encodeURIComponent(gameId)}/publish`,
      { method: "POST", body: { force } },
    ),

  versions: (gameId: string) =>
    request<{ versions: Array<GameDraft & { version: number; publishedAt?: string; publishedByUserId?: string }> }>(
      `/v1/games/${encodeURIComponent(gameId)}/versions`,
    ),

  /** Returns the valid role list alongside the users, so the UI offers
   * exactly the roles the server accepts rather than its own copy that can
   * drift out of step. */
  listUsers: () => request<{ users: ManagedUser[]; roles: RoleId[] }>("/v1/users"),

  createUser: (email: string, password: string, roles: RoleId[]) =>
    request<{ user: ManagedUser }>("/v1/users", { method: "POST", body: { email, password, roles } }),

  updateUser: (userId: string, patch: { roles?: RoleId[]; active?: boolean }) =>
    request<{ user: ManagedUser }>(`/v1/users/${encodeURIComponent(userId)}`, { method: "PUT", body: patch }),

  setUserPassword: (userId: string, password: string) =>
    request<{ passwordSet: boolean }>(`/v1/users/${encodeURIComponent(userId)}/password`, {
      method: "POST",
      body: { password },
    }),

  reportTransactions: (params: ReportQuery & { limit?: number; cursor?: string }) =>
    request<ReportPage>(`/v1/reports/transactions${reportQueryString(params)}`),

  reportSummary: (params: ReportQuery) => request<ReportSummary>(`/v1/reports/summary${reportQueryString(params)}`),

  /**
   * Fetches the CSV as text rather than as JSON.
   *
   * A separate function because `request()` always parses the response as
   * JSON — handing it a CSV would throw on the first comma. And it cannot
   * be a plain `<a href>`: the route requires a bearer token, and a link
   * carries no headers, so the browser would be sent an unauthenticated
   * request and get a 401 page in a new tab. The token cannot go in the
   * query string either — that is the one place credentials must never be,
   * since URLs reach referrer headers, proxy logs and browser history.
   *
   * So the file is fetched with the header and turned into a blob the page
   * downloads itself.
   */
  reportTransactionsCsv: async (params: ReportQuery): Promise<{ csv: string; truncated: boolean }> => {
    const response = await fetch(`${BASE_URL}/v1/reports/transactions${reportQueryString({ ...params, format: "csv" })}`, {
      headers: { ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
    });

    if (!response.ok) {
      if (response.status === 401 && sessionToken) {
        sessionToken = null;
        onSessionLost?.();
      }
      throw new ApiError(response.status, "export_failed", `the export failed (${response.status})`, {});
    }

    return {
      csv: await response.text(),
      // The server sets this when it hit the export ceiling. Read here so
      // the screen can warn — a truncated financial export that looks
      // complete is the failure this whole signal exists to prevent.
      truncated: response.headers.get("x-truncated") === "true",
    };
  },

  supportLookup: (operatorId: string, playerId: string) =>
    request<SupportLookup>(
      `/v1/support/players/${encodeURIComponent(operatorId)}/${encodeURIComponent(playerId)}`,
    ),

  listOperators: () => request<{ operators: ManagedOperator[] }>("/v1/operators"),

  /**
   * The one response that ever carries `apiSecret`. Typed as optional
   * everywhere else — see `ManagedOperator` — so the compiler stops anyone
   * writing a screen that expects to read it back later.
   */
  createOperator: (body: {
    operatorId: string;
    name: string;
    integrationType: "direct" | "reverse";
    enabledGameIds: string[];
  }) => request<{ operator: ManagedOperator & { apiSecret: string } }>("/v1/operators", { method: "POST", body }),

  updateOperator: (operatorId: string, patch: { name?: string; enabledGameIds?: string[]; disabled?: boolean }) =>
    request<{ operator: ManagedOperator }>(`/v1/operators/${encodeURIComponent(operatorId)}`, {
      method: "PUT",
      body: patch,
    }),

  rotateOperatorSecret: (operatorId: string) =>
    request<{ operator: ManagedOperator & { apiSecret: string } }>(
      `/v1/operators/${encodeURIComponent(operatorId)}/rotate-secret`,
      { method: "POST" },
    ),

  audit: (params: { entityId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.entityId) query.set("entityId", params.entityId);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.toString();
    return request<{ entries: AuditEntry[] }>(`/v1/audit${suffix ? `?${suffix}` : ""}`);
  },
};
