/**
 * #3260 — where this daemon's web UI answers, for a client that talks to it
 * over its socket and must not guess the address (tvty's « aiball » entry):
 * the local address it listens on, and the public one when the aiball config
 * declares a tailscale serve for it. Nothing secret, nothing guessed: no
 * provider declared, no public address.
 */
import { execFile } from "node:child_process";
import { AIBALL_VERSION } from "./version.js";
import { loadProviders, type TailscaleProvider } from "./providers.js";

export interface DaemonInfo {
    version: string;
    web_url: string | null;
    public_url: string | null;
}

/** The UI at the address the daemon listens on; a wildcard bind is reached on loopback. */
export function webUrl(host: string, port: number): string | null {
    if (!Number.isInteger(port) || port <= 0) return null;
    const h = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
    return `http://${h.includes(":") ? `[${h}]` : h}:${port}/`;
}

/** The UI behind the tailscale serve the config declares, on this machine's tailnet name. */
export function publicUrl(ts: TailscaleProvider | undefined, dnsName: string | null): string | null {
    if (!ts?.enabled || !dnsName) return null;
    const name = dnsName.replace(/\.$/, "");
    const port = ts.port ?? (ts.mode === "http" ? 80 : 443);
    const defaultPort = ts.mode === "http" ? port === 80 : port === 443;
    const path = ts.path && ts.path !== "/" ? `${ts.path.replace(/\/$/, "")}/` : "/";
    return `${ts.mode}://${name}${defaultPort ? "" : `:${port}`}${path}`;
}

let dnsName: Promise<string | null> | null = null;

/** This machine's name on the tailnet (`tailscale status`), read once, never blocking the event loop. */
function tailnetDnsName(): Promise<string | null> {
    dnsName ??= new Promise((resolve) => {
        execFile("tailscale", ["status", "--self", "--json"], { timeout: 2_000 }, (err, stdout) => {
            if (err) return resolve(null);
            try {
                resolve((JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.trim() || null);
            } catch {
                resolve(null);
            }
        });
    });
    return dnsName;
}

/** What `daemon.info` answers. */
export async function daemonInfo(): Promise<DaemonInfo> {
    const ts = loadProviders().tailscale;
    return {
        version: AIBALL_VERSION,
        web_url: webUrl(process.env.AIBALL_HOST ?? "127.0.0.1", Number(process.env.AIBALL_PORT ?? 7777)),
        public_url: ts?.enabled ? publicUrl(ts, await tailnetDnsName()) : null,
    };
}
