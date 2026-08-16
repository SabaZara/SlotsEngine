import { createLogger } from "@slots-engine/logging";
import { assertOriginPolicy, loadOriginPolicy } from "./origin.js";
import { createSocketServer } from "./server.js";

/**
 * Entry point only: read configuration, refuse to start on a bad one, and
 * hand the rest to `createSocketServer`. The assembly lives there so it can
 * be started on an ephemeral port and driven by a real client in
 * `server.test.ts` — see the note in that file about F6 and F7 both being
 * assembly bugs.
 */
const logger = createLogger("game-socket");
const PORT = Number(process.env.PORT ?? 9003);
/** Concurrent socket ceiling. Generous for a single instance; the point is
 * that "unbounded" is not a number. */
const MAX_CONNECTIONS = Number(process.env.SOCKET_MAX_CONNECTIONS ?? 5000);

// Read and validated before anything binds a port, so a misconfigured
// service fails visibly at boot rather than serving with no origin check.
const originPolicy = loadOriginPolicy();
assertOriginPolicy(originPolicy);

const { httpServer } = createSocketServer({
  originPolicy,
  logger,
  maxConnections: MAX_CONNECTIONS,
});

httpServer.listen(PORT, () => {
  logger.info(`game-socket listening on :${PORT}`);
});
