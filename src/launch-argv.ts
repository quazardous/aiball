/**
 * How to start `cmd args` on this platform. Windows will not spawn a `.cmd` or
 * `.bat` without a shell (Node refuses with EINVAL since the 2024 batch-file
 * fix), so those go through cmd.exe, each argument quoted. Only launchers a
 * human declared in the config reach this, with the arguments written there.
 */
export function launchArgv(cmd: string, args: string[], platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; verbatim: boolean } {
    if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cmd)) return { cmd, args, verbatim: false };
    const quote = (a: string) => (a === "" || /[\s"&|<>^()%!,;=]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${[cmd, ...args].map(quote).join(" ")}"`], verbatim: true };
}
