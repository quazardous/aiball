/**
 * #3412 — the name of a machine, as the API says it: `hub` for the daemon that
 * holds the board, `node:<label>` for a proxy node, `tcp:<address>` for a
 * client that reaches the hub directly over TCP. One vocabulary for where a
 * consumer's loop runs (`consumer.machine`), where a session is held
 * (`session.machine`) and where the caller is (`bus.whoami`): a client
 * compares them, and takes for its own only what runs on its machine.
 *
 * Inside the daemon a connection from its own machine is labelled `local`
 * (`CallerContext.machine`): that word is relative to the daemon that says it,
 * so it never goes out as it is.
 */
import { loadProxy } from "./proxy.js";

let mine: string | null = null;

/** The machine of the daemon that answers: `hub`, or `node:<label>` on a proxy node. */
export function thisMachine(): string {
    if (mine === null) {
        const proxy = loadProxy();
        mine = proxy ? `node:${proxy.nodeLabel ?? "?"}` : "hub";
    }
    return mine;
}

/** A connection's machine as the API says it; null when it is not known. */
export function machineName(label: string | null | undefined): string | null {
    if (!label) return null;
    return label === "local" ? thisMachine() : label;
}

/** Tests — another daemon's identity. */
export function setThisMachineForTests(name: string | null): void {
    mine = name;
}
