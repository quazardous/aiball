/**
 * #3477 — what `list-clients -F …` says, read the same way for tmux and psmux.
 *
 * psmux (3.3.8) ignores `-F` on `list-clients`: whatever the format, each line
 * is its default one, `/dev/pts/4: <session>: <cmd> [120x29] (utf8) [activity=…]`.
 * That line says neither the client's process nor whether it is read-only, and
 * psmux has no other command that does (`display-message -c` ignores `-c`). So
 * under psmux the clients can be counted, not told apart: what needs that says
 * so instead of answering as if it had done it.
 */

/** A line in tmux's default `list-clients` form: the format asked was not applied. */
const DEFAULT_LINE = /^[^\s:]+: [^:]*: .*\[\d+x\d+\]/;

/** The non-empty lines of a `list-clients` answer. */
function lines(stdout: string): string[] {
    return stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

/** Whether the multiplexer answered in its default form, ignoring the format it was asked. */
export function ignoresFormat(stdout: string): boolean {
    return lines(stdout).some((l) => DEFAULT_LINE.test(l));
}

/**
 * `list-clients -F '#{client_readonly}'`: how many clients, and how many have
 * the controls — null when the multiplexer cannot say (psmux).
 */
export function parseClientCounts(stdout: string): { clients: number; interactive: number | null } {
    const all = lines(stdout);
    if (ignoresFormat(stdout)) return { clients: all.length, interactive: null };
    return { clients: all.length, interactive: all.filter((f) => f === "0").length };
}

export interface ClientEntry {
    client: string;
    pid: number;
    readonly: boolean;
}

/**
 * `list-clients -F '#{client_name} #{client_pid} #{client_readonly}'`: each
 * client; null when the multiplexer cannot tell them apart (psmux).
 */
export function parseClientList(stdout: string): ClientEntry[] | null {
    if (ignoresFormat(stdout)) return null;
    return lines(stdout).map((l) => l.split(" ")).filter((f) => f.length === 3)
        .map(([client, pid, ro]) => ({ client: client!, pid: Number(pid), readonly: ro === "1" }));
}
