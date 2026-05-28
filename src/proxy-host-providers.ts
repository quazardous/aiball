/**
 * #524 david `eew6nn` + `5w37f2` — provider abstraction côté node : chaque
 * provider sait comment résoudre un hostname "correct" pour SA techno (tailscale,
 * hostname plat, demain zerotier / cloudflare-tunnel / …). Le résultat est shippé
 * dans la frame `hello` du WS proxy → daemon persiste sur `tokens` →
 * NodesPanel affiche `display_host` au lieu de `last_seen_ip` (toujours
 * 127.0.0.1 quand un reverse-proxy local strippe l'origine tailnet).
 *
 * Chain ordonnée : on essaie chaque provider dans l'ordre, le premier non-null
 * gagne. Tailscale d'abord (info plus riche : on sait qu'on est dans un tailnet) ;
 * hostname sinon (toujours dispo). Le résultat est mémoïsé pour la vie du process
 * — le `display_host` ne changera pas tant que la machine ne bouge pas.
 */
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";

export interface DisplayHost {
    host: string;
    provider: string;
}

export interface HostProvider {
    /** Stable identifier exposé en UI dans le chip provider. */
    id: string;
    /** Tente de résoudre le hostname. Retourne null quand la techno n'est pas
     *  active sur cette machine (binaire absent, non-loggué, ...). */
    detect(): DisplayHost | null;
}

/** Tailscale : `tailscale status --self --json`, on lit `Self.HostName`. David
 *  `5w37f2` a tranché : HostName court (`graphite`) plutôt que DNSName FQDN
 *  (`graphite.tail-XXXX.ts.net`) — info utile sans le bruit du tailnet name. */
export const tailscaleProvider: HostProvider = {
    id: "tailscale",
    detect(): DisplayHost | null {
        try {
            const r = spawnSync("tailscale", ["status", "--self", "--json"], {
                encoding: "utf8",
                timeout: 2_000,
                stdio: ["ignore", "pipe", "ignore"],
            });
            if (r.status !== 0 || !r.stdout) return null;
            const parsed = JSON.parse(r.stdout) as { Self?: { HostName?: string } };
            const h = parsed.Self?.HostName?.trim();
            return h ? { host: h, provider: "tailscale" } : null;
        } catch {
            return null;
        }
    },
};

/** Fallback générique : `os.hostname()`. Toujours disponible. */
export const hostnameProvider: HostProvider = {
    id: "hostname",
    detect(): DisplayHost | null {
        const h = hostname().trim();
        return h ? { host: h, provider: "hostname" } : null;
    },
};

/** Chain par défaut. L'ordre matters : tailscale d'abord (plus riche), hostname
 *  en dernier ressort. Pour étendre demain : insérer avant `hostnameProvider`. */
export const defaultProviderChain: HostProvider[] = [
    tailscaleProvider,
    hostnameProvider,
];

let cached: DisplayHost | null | undefined = undefined;

/** Résout via la chain, mémoïsé pour la vie du process. Le `display_host`
 *  d'une machine ne change pas en cours de session (pas de hot-swap tailscale). */
export function resolveDisplayHost(chain: HostProvider[] = defaultProviderChain): DisplayHost | null {
    if (cached !== undefined) return cached;
    for (const p of chain) {
        const r = p.detect();
        if (r) { cached = r; return r; }
    }
    cached = null;
    return null;
}

/** Test-only : reset du cache mémoïsé (entre tests qui simulent différents
 *  layouts de chain). N'est pas exporté côté barrel — usage interne tests. */
export function _resetDisplayHostCacheForTests(): void {
    cached = undefined;
}
