/**
 * #3416 — the multiplexer command the loop drives: `MUX_CMD`, else `tmux`, and
 * on Windows `psmux` when it is there.
 *
 * On Windows the multiplexer is psmux, which also installs a `tmux.exe` alias.
 * The alias costs far more to start than `psmux.exe` itself — measured on one
 * machine: 250-300 ms a call against 35-65 ms, for the same command and the
 * same output. The kernel calls it several times a second, each call blocking:
 * through the alias it spent half a core doing so and answered in a second.
 *
 * So on Windows a bare `tmux` — the default, or what an already running loop
 * has in its env file — means psmux when `psmux.exe` is on the PATH. Anything
 * else in `MUX_CMD` (a path, another name) is taken as given.
 */
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * Is `<name>.exe` in one of the PATH's folders? No process is started to find
 * out. A Windows PATH, read with Windows' own rules (`;` between folders, `\`
 * inside them) whatever platform runs this: the question is only asked there.
 */
export function onWindowsPath(name: string, pathVar: string | undefined = process.env.PATH, exists: (p: string) => boolean = existsSync): boolean {
    return (pathVar ?? "").split(win32.delimiter).some((dir) => dir !== "" && exists(win32.join(dir, `${name}.exe`)));
}

export function resolveMuxCmd(
    configured: string | undefined,
    platform: NodeJS.Platform = process.platform,
    hasPsmux: () => boolean = () => onWindowsPath("psmux"),
): string {
    const cmd = configured || "tmux";
    if (platform === "win32" && cmd === "tmux" && hasPsmux()) return "psmux";
    return cmd;
}
