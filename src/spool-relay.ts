/**
 * #4864 — a proxy node's spool goes to its parent.
 *
 * A client of the node spools a write when the node answers 5xx, as it does
 * while the parent is out of reach. The node used to replay it through its own
 * method table, into the empty database it opens at boot: refused, moved to
 * `failed/`, lost for the board. Here each spooled write is posted to the
 * parent's bus, as its author, the way the node relays its clients (its token,
 * the author named in `x-aiball-consumer`), with the write's idempotency key,
 * so a write that had in fact gone through is not made twice.
 *
 * - The parent answers 4xx to the write: refused (`failed/`), as a live call.
 * - The parent cannot be reached, or refuses the node itself: the file stays,
 *   for the drain the node's reconnection starts.
 * - Strict mode: the node lends no token, and the spool keeps none, so the
 *   write cannot be replayed from here; it stays, and the log says why.
 */
import { BusClient, BusError } from "./bus-client.js";
import { relayAuthorization, type ProxyConfig, type ProxyTokenStore } from "./proxy.js";
import { SpoolRefused, type SpoolPoster } from "./spool.js";

export function relaySpoolPoster(cfg: ProxyConfig, store: ProxyTokenStore): SpoolPoster {
    return async (msg, author) => {
        const auth = relayAuthorization(cfg, store, undefined);
        if (!auth.ok || !auth.authorization) {
            throw new Error("strict mode: the node lends no token and the spool keeps none; replay it from its author's client");
        }
        const headers: Record<string, string> = { authorization: auth.authorization, "x-aiball-consumer": author };
        if (cfg.nodeLabel) headers["x-aiball-node-label"] = cfg.nodeLabel;
        const client = await BusClient.connect({ url: cfg.url, headers });
        try {
            await client.call("message.post", msg);
        } catch (e) {
            if (e instanceof BusError && e.status >= 400 && e.status < 500) {
                throw new SpoolRefused(`refused by the parent (${e.status} ${e.code}): ${e.message}`);
            }
            throw e;
        } finally {
            client.close();
        }
    };
}
