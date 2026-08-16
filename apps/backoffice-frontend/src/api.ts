import type {
  BonusModuleConfig,
  GridSize,
  PaylinePath,
  PaylineWinRule,
  ReelGenerationMode,
  ReelStrip,
  RoleId,
  SymbolRule,
  SymbolWeight,
} from "@slots-engine/shared-types";

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

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; expiresAt: number; user: SessionUser }>("/v1/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  me: () => request<{ user: SessionUser }>("/v1/auth/me"),

  logout: () => request<{ loggedOut: boolean }>("/v1/auth/logout", { method: "POST" }),

  listGames: () => request<{ games: GameListEntry[] }>("/v1/games"),

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
      body: patch,
    }),

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

  audit: (params: { entityId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.entityId) query.set("entityId", params.entityId);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.toString();
    return request<{ entries: AuditEntry[] }>(`/v1/audit${suffix ? `?${suffix}` : ""}`);
  },
};
