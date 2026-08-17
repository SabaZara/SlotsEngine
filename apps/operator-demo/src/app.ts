import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { IntegrationClient } from "./client.js";
import { renderError, renderGame, renderLobby } from "./pages.js";

export interface BuildAppOptions {
  client: IntegrationClient;
  operatorId: string;
  /** Minor units credited before each launch. Demo convenience only — see
   * the note rendered on the lobby page. */
  topUpAmount: number;
  /** Injectable so tests get deterministic ids rather than asserting on a
   * UUID they cannot predict. */
  newId?: () => string;
}

/**
 * A reference integrator, in the smallest honest form.
 *
 * The property worth stating first, because it is what makes this a
 * demonstration of the protocol rather than a toy: **the operator's secret
 * never leaves this process.** The browser posts a form here, this server
 * signs two calls to integration-api, and the browser only ever receives a
 * launch URL. A real aggregator's frontend is in exactly the same position
 * — it cannot be trusted with the credential that moves money.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { client, operatorId, topUpAmount, newId = randomUUID } = options;
  const app = Fastify({ logger: false });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/health", async () => ({ service: "operator-demo", status: "ok" }));

  app.get("/", async (_request, reply) => {
    // A failure to list games must not take the lobby down — the page still
    // renders with a text field, because "we could not ask" and "you have
    // no games" are different answers and only one of them is actionable.
    let games: Array<{ gameId: string; name: string }> = [];
    let listUnavailable = false;
    try {
      const response = await client.listGames();
      if (response.ok) games = response.body.games;
      else listUnavailable = true;
    } catch {
      listUnavailable = true;
    }

    return reply.type("text/html").send(
      renderLobby({ operatorId, suggestedPlayerId: newId(), games, topUpAmount, listUnavailable }),
    );
  });

  /**
   * The launch, and the one place this demo deliberately diverges from the
   * reference implementation.
   *
   * The reference does Post/Redirect/Get: it mints a token, then redirects
   * to a GET carrying the `launchUrl` in the query string, so a refresh
   * re-GETs rather than re-submitting. That is the right pattern **there**,
   * because its game client stores a session token and substitutes it for a
   * spent launch token on reload.
   *
   * This repo's client does not. `game-frontend` holds its session token in
   * memory only (`api.ts`), so a refresh loses it and the spent launch token
   * in the URL is fatal — the player would get `invalid_token` on the one
   * gesture people make when something looks stuck.
   *
   * So the render happens on the POST, and each load mints a fresh token.
   * The cost is a repeated top-up on refresh, which is meaningless in a demo
   * economy. Copying the reference here would have produced a page that
   * works once and breaks on reload, which is the kind of defect that
   * survives a review because nobody refreshes during a demo.
   */
  app.post<{ Body: { playerId?: string; gameId?: string } }>("/launch", async (request, reply) => {
    const { playerId, gameId } = request.body ?? {};
    if (!playerId || !gameId) {
      return reply.code(400).type("text/html").send(renderError("A player ID and a game are both required."));
    }

    // Top up first: launching a player with no balance produces a game that
    // can only answer `insufficient_funds`, which demonstrates nothing.
    const topUp = await client.cashIn({ transactionId: newId(), playerId, amount: topUpAmount });
    if (!topUp.ok) {
      return reply
        .code(502)
        .type("text/html")
        .send(renderError(`The top-up was refused (HTTP ${topUp.status}).`, topUp.body));
    }

    const launch = await client.launch({ playerId, gameId });
    if (!launch.ok) {
      return reply
        .code(502)
        .type("text/html")
        .send(renderError(`The launch was refused (HTTP ${launch.status}).`, launch.body));
    }

    return reply.type("text/html").send(renderGame(launch.body.launchUrl));
  });

  // A bare GET here means someone refreshed the old reference-style URL, or
  // navigated directly. Send them to the lobby rather than erroring: there
  // is nothing to render, and a launch is one click away.
  app.get("/launch", async (_request, reply) => reply.redirect("/", 302));

  return app;
}
