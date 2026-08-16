#!/usr/bin/env node
/**
 * End-to-end check of the authoring loop against RUNNING services.
 *
 * Drives the path a designer actually takes — log in, create a game, tune
 * it, watch the RTP gate refuse a bad one, publish a good one, then confirm
 * the published game is immediately playable by the game-backend that
 * serves real players. That last step is the one unit tests cannot make:
 * it proves the two services agree about what a published game is.
 *
 * Run with:  npm run e2e:backoffice
 */

const BACKOFFICE = process.env.BACKOFFICE_URL ?? "http://localhost:9105";
const BACKEND = process.env.GAME_BACKEND_URL ?? "http://localhost:9102";
const EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@example.com";
const PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || "admin";

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

let token = null;
async function api(path, options = {}) {
  const response = await fetch(`${BACKOFFICE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

/** A real, simulation-verified 5x3 game — the same maths the engine ships
 * as its reference, so the RTP gate should accept it. */
function tunedGame() {
  const outer = [
    "ten", "jack", "cherry", "queen", "bell", "ten", "king", "jack", "plum", "queen",
    "ten", "bell", "jack", "ace", "cherry", "queen", "ten", "plum", "king", "jack",
    "seven", "ten", "queen", "bell", "jack", "cherry", "ten", "ace", "queen", "plum",
    "scatter", "ten", "jack", "king", "queen", "ten", "bell", "jack", "cherry", "star",
  ];
  const inner = [
    "ten", "jack", "wild", "queen", "cherry", "ten", "bell", "jack", "king", "plum",
    "ten", "queen", "jack", "seven", "bell", "ten", "cherry", "queen", "ace", "jack",
    "ten", "plum", "star", "king", "queen", "ten", "jack", "bell", "cherry", "queen",
    "scatter", "ten", "jack", "ace", "plum", "ten", "queen", "bell", "jack", "king",
  ];
  return {
    grid: { reels: 5, rows: 3 },
    reelGenerationMode: "reel-strip",
    reelStrips: [
      { reelIndex: 0, symbols: outer },
      { reelIndex: 1, symbols: inner },
      { reelIndex: 2, symbols: inner },
      { reelIndex: 3, symbols: inner },
      { reelIndex: 4, symbols: outer },
    ],
    paylines: [
      [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
      [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 1, 0, 1],
    ],
    symbols: [
      { symbol: "ten", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 10, 4: 29, 5: 92 } },
      { symbol: "jack", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 10, 4: 29, 5: 92 } },
      { symbol: "queen", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 14, 4: 39, 5: 148 } },
      { symbol: "king", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 19, 4: 53, 5: 187 } },
      { symbol: "ace", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 21, 4: 73, 5: 280 } },
      { symbol: "cherry", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 26, 4: 79, 5: 265 } },
      { symbol: "plum", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 33, 4: 106, 5: 335 } },
      { symbol: "bell", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 53, 4: 159, 5: 530 } },
      { symbol: "seven", allowedReels: [0, 1, 2, 3, 4], role: "regular", paytable: { 3: 132, 4: 530, 5: 1975 } },
      {
        symbol: "wild", allowedReels: [1, 2, 3], role: "wild", paytable: { 3: 66, 4: 265, 5: 985 },
        wildConfig: { substitutesFor: "all-regular", multiplier: 2 },
      },
      {
        symbol: "scatter", allowedReels: [0, 1, 2, 3, 4], role: "scatter",
        scatterConfig: { multiplierOf: "totalBet", payout: { 3: 3, 4: 15, 5: 80 } },
      },
      {
        symbol: "star", allowedReels: [0, 1, 2, 3, 4], role: "bonusTrigger",
        bonusTriggerConfig: { module: "wheel", minCount: 3 },
      },
    ],
    bonusModules: [{ moduleId: "wheel", params: { rewardMultipliers: [2, 3, 5, 8, 12, 20, 35, 50] } }],
    rtpTarget: 0.95,
    betOptions: [100, 200, 500, 1000],
    currency: "USD",
  };
}

async function main() {
  const gameId = `e2e-game-${Date.now()}`;

  console.log("\n1. Unauthenticated access is refused");
  const anonymous = await api("/v1/games");
  check("listing games without a token is 401", anonymous.status === 401, `got ${anonymous.status}`);

  console.log("\n2. Login");
  const login = await api("/v1/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  check("logs in with the seeded administrator", login.status === 200, JSON.stringify(login.payload).slice(0, 140));
  check("never returns a password hash", !("passwordHash" in (login.payload.user ?? {})));
  token = login.payload.token;
  if (!token) {
    console.error("\ncannot continue without a session token\n");
    process.exit(1);
  }

  console.log("\n3. Wrong credentials are rejected indistinguishably");
  const wrongPassword = await api("/v1/auth/login", { method: "POST", body: { email: EMAIL, password: "nope" } });
  const unknownUser = await api("/v1/auth/login", { method: "POST", body: { email: "ghost@x.com", password: "nope" } });
  check("both fail with 401", wrongPassword.status === 401 && unknownUser.status === 401);
  check(
    "and with an identical body, so accounts cannot be enumerated",
    JSON.stringify(wrongPassword.payload) === JSON.stringify(unknownUser.payload),
  );

  console.log("\n4. Create a game");
  const created = await api("/v1/games", { method: "POST", body: { gameId, name: "E2E Game" } });
  check("creates from a valid starter draft", created.status === 201, JSON.stringify(created.payload).slice(0, 140));
  const duplicate = await api("/v1/games", { method: "POST", body: { gameId, name: "Clash" } });
  check("refuses to reuse an existing gameId", duplicate.status === 409, `got ${duplicate.status}`);

  console.log("\n5. A draft is not playable until published");
  const notYetLive = await fetch(`${BACKEND}/public/games/${gameId}`);
  check("game-backend does not serve an unpublished game", notYetLive.status === 404, `got ${notYetLive.status}`);

  console.log("\n6. Invalid edits are saved but reported");
  const invalid = await api(`/v1/games/${gameId}`, { method: "PUT", body: { betOptions: [1.5] } });
  check("a fractional bet option is rejected as invalid", invalid.payload.valid === false);
  check("and the reason names minor units", /minor units/.test(invalid.payload.errors?.[0] ?? ""));

  console.log("\n7. The RTP gate refuses a mistuned game");
  await api(`/v1/games/${gameId}`, { method: "PUT", body: { ...tunedGame(), rtpTarget: 0.5 } });
  const blocked = await api(`/v1/games/${gameId}/publish`, { method: "POST", body: {} });
  check("publish is refused with 422", blocked.status === 422, `got ${blocked.status}`);
  check("because measured RTP misses the target", blocked.payload.error === "rtp_out_of_tolerance");
  const stillNotLive = await fetch(`${BACKEND}/public/games/${gameId}`);
  check("and nothing went live", stillNotLive.status === 404);

  console.log("\n8. RTP preview before publishing");
  await api(`/v1/games/${gameId}`, { method: "PUT", body: tunedGame() });
  const preview = await api(`/v1/games/${gameId}/simulate`, { method: "POST", body: { simCount: 20000 } });
  const measured = preview.payload.simulation?.resultRtp;
  check("returns a measured RTP", typeof measured === "number", JSON.stringify(preview.payload).slice(0, 140));
  check("close to the 0.95 target", Math.abs(measured - 0.95) < 0.06, `measured ${measured?.toFixed(4)}`);

  console.log("\n9. Publish a well-tuned game");
  const published = await api(`/v1/games/${gameId}/publish`, { method: "POST", body: {} });
  check("publish succeeds", published.status === 200, JSON.stringify(published.payload).slice(0, 160));
  check("at version 1", published.payload.gameDef?.version === 1);
  check("with a recorded simulation", typeof published.payload.simulation?.resultRtp === "number");

  console.log("\n10. The published game is immediately playable");
  // The step no unit test can make: the authoring service and the money
  // service agree about what a published game is.
  const liveView = await fetch(`${BACKEND}/public/games/${gameId}`).then((r) => r.json());
  check("game-backend now serves it", liveView.gameId === gameId);
  check("withholding reel strips", !("reelStrips" in liveView));
  check("withholding the RTP target", !("rtpTarget" in liveView));
  check("exposing the paytable a player is entitled to", (liveView.symbols ?? []).some((s) => s.paytable));

  console.log("\n11. Republishing bumps the version and keeps history");
  const republished = await api(`/v1/games/${gameId}/publish`, { method: "POST", body: {} });
  check("second publish is version 2", republished.payload.gameDef?.version === 2);
  const versions = await api(`/v1/games/${gameId}/versions`);
  check("both versions are retained", (versions.payload.versions ?? []).length === 2);

  console.log("\n12. The audit trail records who did it");
  const audit = await api(`/v1/audit?entityId=${gameId}`);
  const publishes = (audit.payload.entries ?? []).filter((e) => e.action === "game.publish");
  check("both publishes are logged", publishes.length === 2, `found ${publishes.length}`);
  check("with the acting user", typeof publishes[0]?.actorUserId === "string");
  check("and the measured RTP", typeof publishes[0]?.diff?.resultRtp === "number");

  console.log("\n13. User management");
  const staffEmail = `e2e-designer-${Date.now()}@example.com`;
  const staffPassword = "a-long-enough-password";

  const createdUser = await api("/v1/users", {
    method: "POST",
    body: { email: staffEmail, password: staffPassword, roles: ["game_designer"] },
  });
  check("creates a user", createdUser.status === 201, JSON.stringify(createdUser.payload).slice(0, 140));
  check("without ever returning a password hash", !("passwordHash" in (createdUser.payload.user ?? {})));
  const staffId = createdUser.payload.user?.userId;

  const duplicateUser = await api("/v1/users", {
    method: "POST",
    body: { email: staffEmail, password: staffPassword, roles: ["viewer"] },
  });
  check("refuses a duplicate email", duplicateUser.status === 409, `got ${duplicateUser.status}`);

  const shortPassword = await api("/v1/users", {
    method: "POST",
    body: { email: `x-${Date.now()}@example.com`, password: "short", roles: ["viewer"] },
  });
  check("refuses a short password", shortPassword.status === 400);

  // The new account must actually work — a created user who cannot sign in
  // is the failure this whole screen exists to prevent.
  const adminToken = token;
  const staffLogin = await api("/v1/auth/login", { method: "POST", body: { email: staffEmail, password: staffPassword } });
  check("the new user can sign in", staffLogin.status === 200, JSON.stringify(staffLogin.payload).slice(0, 140));

  token = staffLogin.payload.token;
  const staffSeesGames = await api("/v1/games");
  const staffDeniedUsers = await api("/v1/users");
  check("a designer can reach games", staffSeesGames.status === 200);
  check("but not user management", staffDeniedUsers.status === 403, `got ${staffDeniedUsers.status}`);

  console.log("\n14. A role change signs that user out everywhere");
  // The bug this guards: a token carries its own copy of the roles, so
  // without revoking, a demoted user keeps their old access until it expires.
  token = adminToken;
  const demoted = await api(`/v1/users/${staffId}`, { method: "PUT", body: { roles: ["viewer"] } });
  check("roles are changed", demoted.status === 200, JSON.stringify(demoted.payload).slice(0, 140));

  token = staffLogin.payload.token;
  const staleToken = await api("/v1/games");
  check("the user's existing token is rejected immediately", staleToken.status === 401, `got ${staleToken.status}`);

  console.log("\n15. Deactivation takes effect at once");
  token = adminToken;
  check("deactivates the account", (await api(`/v1/users/${staffId}`, { method: "PUT", body: { active: false } })).status === 200);
  const deactivatedLogin = await api("/v1/auth/login", {
    method: "POST",
    body: { email: staffEmail, password: staffPassword },
  });
  check("a deactivated user cannot sign back in", deactivatedLogin.status === 401, `got ${deactivatedLogin.status}`);

  console.log("\n16. The system refuses to lock itself out");
  const me = await api("/v1/auth/me");
  const selfDeactivate = await api(`/v1/users/${me.payload.user?.userId}`, { method: "PUT", body: { active: false } });
  check("self-deactivation is refused", selfDeactivate.status === 409, `got ${selfDeactivate.status}`);
  const selfDemote = await api(`/v1/users/${me.payload.user?.userId}`, { method: "PUT", body: { roles: ["viewer"] } });
  check(
    "removing the last administrator is refused",
    selfDemote.status === 409 && selfDemote.payload.error === "last_super_admin",
    `got ${selfDemote.status} ${selfDemote.payload.error}`,
  );
  check("and the admin still works afterwards", (await api("/v1/users")).status === 200);

  console.log("\n17. Logging out revokes the token everywhere");
  await api("/v1/auth/logout", { method: "POST" });
  const afterLogout = await api("/v1/games");
  check("the old token stops working immediately", afterLogout.status === 401, `got ${afterLogout.status}`);

  console.log(failures === 0 ? "\nAll backoffice checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nbackoffice check failed to run:", err.message);
  console.error("Are the services up?  docker compose -f infra/docker-compose.yml up");
  process.exit(1);
});
