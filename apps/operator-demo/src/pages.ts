/**
 * The two pages this demo serves.
 *
 * Kept apart from the routes so the escaping can be tested without a
 * server, which matters more here than it looks: **a game's name is
 * designer-entered free text**, arriving from `GET /v1/games`, and it is
 * interpolated straight into this markup. That is untrusted input the
 * moment it is written into a page — untrusted not because a designer is
 * an attacker, but because the field has no validation saying otherwise
 * and the operator's own lobby is what ends up rendering it.
 */

/**
 * Escapes the five characters that are significant in HTML.
 *
 * `'` and `"` are included even though every interpolation below sits in
 * element content rather than an attribute, where they cannot break out.
 * The reason is that the safety of *this* function should not depend on
 * where the next person calls it: escaping only `&<>` is correct until
 * somebody interpolates into `value="…"`, and then it silently is not.
 */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string,
  );
}

const STYLE = `
  :root { color-scheme: dark; }
  body { background:#05070f; color:#e8ecf8; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         padding:40px; max-width:620px; margin:0 auto; line-height:1.5; }
  h1 { font-size:18px; margin:0 0 4px; }
  p.lede { color:#8b93ad; font-size:13px; margin:0 0 24px; }
  label { display:block; margin-top:16px; font-size:13px; }
  input, select { width:100%; padding:9px; margin-top:6px; background:#12162a; color:#e8ecf8;
                  border:1px solid #2a3050; border-radius:4px; font-family:inherit; font-size:13px; }
  button { margin-top:24px; padding:10px 20px; background:#3b82f6; color:#fff; border:none;
           border-radius:4px; cursor:pointer; font-family:inherit; font-size:13px; }
  .note { color:#8b93ad; font-size:12px; margin-top:24px; border-top:1px solid #2a3050; padding-top:16px; }
  .error { background:#2a1216; border:1px solid #7f1d1d; padding:12px; border-radius:4px; font-size:13px; }
  code { color:#9ecbff; }
`;

export interface GameOption {
  gameId: string;
  name: string;
}

/**
 * The lobby form.
 *
 * The game list is fetched rather than typed, and that is the same
 * entitlement `/v1/launch` enforces at issuance — so every option here is
 * one a launch would actually accept. When the list cannot be loaded it
 * degrades to a text field rather than an empty dropdown: an empty
 * dropdown is a dead end that looks like "you have no games", when the
 * truth is "we could not ask".
 */
export function renderLobby(options: {
  operatorId: string;
  suggestedPlayerId: string;
  games: GameOption[];
  topUpAmount: number;
  listUnavailable: boolean;
}): string {
  const { operatorId, suggestedPlayerId, games, topUpAmount, listUnavailable } = options;

  const gameField = listUnavailable
    ? `<input name="gameId" required placeholder="reference-5x3" />
       <p class="lede">Could not load the game list from integration-api — type a gameId directly.</p>`
    : games.length === 0
      ? `<p class="error">This operator is entitled to no published games. Grant one in the backoffice
         (Operators &rarr; Games this operator may launch), and make sure it is published.</p>`
      : `<select name="gameId" required>
        ${games
          .map((game) => `<option value="${escapeHtml(game.gameId)}">${escapeHtml(game.name)} (${escapeHtml(game.gameId)})</option>`)
          .join("\n        ")}
      </select>`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Operator demo — ${escapeHtml(operatorId)}</title><style>${STYLE}</style></head>
<body>
  <h1>Operator demo — ${escapeHtml(operatorId)}</h1>
  <p class="lede">Stands in for an aggregator's lobby. Signing happens here, server-side; the
  operator's secret never reaches this page.</p>

  <form method="POST" action="/launch">
    <label>Player ID
      <input name="playerId" value="${escapeHtml(suggestedPlayerId)}" required />
    </label>
    <label>Game
      ${gameField}
    </label>
    <button type="submit">Launch game</button>
  </form>

  <p class="note">On launch this tops the player up by ${topUpAmount} minor units before handing off,
  because a player with no balance can only be shown an <code>insufficient_funds</code> error. A real
  operator cashes in when its player actually deposits, not on every launch.</p>
</body>
</html>`;
}

/** The game itself, full-bleed in an iframe — the player stays on the
 * operator's page rather than being sent away, which is how an aggregator
 * usually embeds a game inside its own chrome. */
export function renderGame(launchUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Operator demo — playing</title>
<style>
  html, body { margin:0; height:100%; background:#05070f; }
  iframe { width:100%; height:100%; border:none; display:block; }
</style>
</head>
<body>
  <iframe src="${escapeHtml(launchUrl)}" allow="autoplay"></iframe>
</body>
</html>`;
}

export function renderError(message: string, detail?: unknown): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Operator demo — failed</title><style>${STYLE}</style></head>
<body>
  <h1>That launch did not work</h1>
  <p class="error">${escapeHtml(message)}</p>
  ${detail !== undefined ? `<pre class="note">${escapeHtml(JSON.stringify(detail, null, 2))}</pre>` : ""}
  <p class="note"><a href="/" style="color:#9ecbff;">Back to the lobby</a></p>
</body>
</html>`;
}
