/**
 * #2090 — `aiball init gnome-extension` deploys a DIRECTORY, which is the one
 * way it differs from `init skill`'s single file.
 *
 * That difference is the thing worth pinning: a refresh has to REPLACE the
 * destination, not merge into it. A stale `extension.js` from an older layout,
 * left behind next to the new files, is loaded by the shell all the same —
 * a broken extension with no error pointing at the leftover.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// `copyGnomeExtension` rather than `installGnomeExtension`: the latter reports
// through `die()`, which exits the process, so a refusal is only observable as
// a verdict. Testing the exit would test the CLI wrapper, not the decision.
const { copyGnomeExtension, GNOME_EXTENSION_UUID, gnomeExtensionOffer, enabledExtensionsWith } = await import("./bootstrap.js");

/**
 * Comments are stripped before the credential check below. Without this the
 * assertion matches the prose EXPLAINING why there is no bearer token — a
 * test that fails on its own documentation is testing the wrong artefact.
 */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const targets: string[] = [];
function freshTarget(): string {
    const d = mkdtempSync(join(tmpdir(), "aiball-2090-"));
    targets.push(d);
    return d;
}

test("it lands the whole extension, not just a manifest", () => {
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const dir = join(target, GNOME_EXTENSION_UUID);
    for (const f of ["metadata.json", "extension.js", "aiballClient.js", "daemonActions.js", "tailscaleState.js", "stylesheet.css", "icons/aiball-symbolic.svg"]) {
        assert.ok(existsSync(join(dir, f)), `${f} is missing — the shell needs all of them`);
    }
});

test("the manifest declares the uuid the directory is named after", () => {
    // GNOME matches the two; a mismatch makes the extension invisible with no
    // error the user can act on.
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const meta = JSON.parse(
        readFileSync(join(target, GNOME_EXTENSION_UUID, "metadata.json"), "utf8"),
    ) as { uuid: string; "shell-version": string[] };
    assert.equal(meta.uuid, GNOME_EXTENSION_UUID);
    assert.ok(meta["shell-version"].length > 0, "an empty shell-version installs nowhere");
});

test("a refresh REPLACES the directory — a stale file does not survive it", () => {
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const dir = join(target, GNOME_EXTENSION_UUID);
    const stale = join(dir, "extensionOldLayout.js");
    writeFileSync(stale, "// left over from a previous version\n", "utf8");

    copyGnomeExtension({ target, force: true });

    assert.ok(!existsSync(stale), "the leftover would be loaded alongside the new files");
    assert.ok(existsSync(join(dir, "extension.js")), "and the real files are back");
});

test("it refuses to clobber without --overwrite", () => {
    const target = freshTarget();
    assert.equal(copyGnomeExtension({ target, force: false }).kind, "installed");
    assert.equal(copyGnomeExtension({ target, force: false }).kind, "skipped-exists");
});

test("the extension holds no token, and asks for none", () => {
    // The whole security argument of #2090 in one assertion: it reads the Unix
    // socket, where same-uid access IS the trust boundary. If it ever grew a
    // bearer header or an Authorization line, it would need a credential to
    // live inside a GNOME extension — which is the thing we refused to do.
    const target = freshTarget();
    copyGnomeExtension({ target, force: false });
    const dir = join(target, GNOME_EXTENSION_UUID);
    for (const f of ["extension.js", "aiballClient.js", "daemonActions.js", "tailscaleState.js"]) {
        const src = stripComments(readFileSync(join(dir, f), "utf8"));
        assert.doesNotMatch(src, /Authorization|Bearer|aiball_token|AIBALL_TOKEN/i, `${f}`);
    }
    assert.match(readFileSync(join(dir, "aiballClient.js"), "utf8"), /UnixSocketAddress/);
});

// #2251 — the menu's daemon actions. They live in an import-free module so the
// commands are pinned here, without a GNOME Shell; the probe script covers the
// shell loading it.
const ACTIONS_FILE = join(import.meta.dirname, "..", "..", "gnome", GNOME_EXTENSION_UUID, "daemonActions.js");
type Action = { id: string; argv: string[]; when: "up" | "down" };
const actions = await import(pathToFileURL(ACTIONS_FILE).href) as {
    ACTIONS: Action[];
    AUTOSTART: { query: string[]; enable: string[]; disable: string[] };
    isActionSensitive: (a: Action, up: boolean | null) => boolean;
    autostartFromIsEnabled: (stdout: string) => boolean;
};

test("the actions module stays loadable outside the shell (no gi:// or resource:// import)", () => {
    assert.doesNotMatch(stripComments(readFileSync(ACTIONS_FILE, "utf8")), /gi:\/\/|resource:\/\//);
});

test("each action runs the command it names — start and stop through systemd, not a second path", () => {
    const argv = Object.fromEntries(actions.ACTIONS.map((a) => [a.id, a.argv.join(" ")]));
    assert.deepEqual(argv, {
        start: "systemctl --user start aiball",
        stop: "systemctl --user stop aiball",
        restart: "aiball restart",
        reload: "aiball reload",
    });
    assert.equal(actions.AUTOSTART.query.join(" "), "systemctl --user is-enabled aiball");
    assert.equal(actions.AUTOSTART.enable.join(" "), "systemctl --user enable aiball");
    assert.equal(actions.AUTOSTART.disable.join(" "), "systemctl --user disable aiball");
});

test("an action is clickable only when it applies: start while down, the others while up", () => {
    const clickable = (up: boolean | null) =>
        actions.ACTIONS.filter((a) => actions.isActionSensitive(a, up)).map((a) => a.id).sort();
    assert.deepEqual(clickable(true), ["reload", "restart", "stop"]);
    assert.deepEqual(clickable(false), ["start"]);
    assert.deepEqual(clickable(null), ["reload", "restart", "start", "stop"], "unknown state guesses nothing");
});

test("the Start at login switch is on only for \`enabled\`", () => {
    assert.equal(actions.autostartFromIsEnabled("enabled\n"), true);
    for (const other of ["disabled\n", "static", "masked", "", "enabled-runtime"]) {
        assert.equal(actions.autostartFromIsEnabled(other), false, other);
    }
});

test("the top-bar icon is the logo file, named -symbolic so the shell recolours it", () => {
    const ext = stripComments(readFileSync(join(ACTIONS_FILE, "..", "extension.js"), "utf8"));
    assert.match(ext, /icons\/aiball-symbolic\.svg/);
    assert.doesNotMatch(ext, /view-list-symbolic|action-unavailable-symbolic/, "the generic theme icons are gone");
    const svg = readFileSync(join(ACTIONS_FILE, "..", "icons", "aiball-symbolic.svg"), "utf8");
    assert.match(svg, /<svg[^>]*viewBox="0 0 16 16"/, "drawn on the 16 px grid of a panel icon");
});

// #2251 — the tailnet section, pinned against the shapes tailscale really prints.
const TAILNET_FILE = join(import.meta.dirname, "..", "..", "gnome", GNOME_EXTENSION_UUID, "tailscaleState.js");
type TailnetState = { visible: boolean; line: string; url: string | null; canExpose: boolean };
const tailnet = await import(pathToFileURL(TAILNET_FILE).href) as {
    TAILNET: Record<string, string[]>;
    tailscaleProvider: (stdout: string | null) => { enabled?: boolean; path?: string } | null;
    tailscaleConnection: (stdout: string | null) => { connected: boolean; host: string | null };
    aiballTailnetUrl: (stdout: string | null, port: number, path?: string) => string | null;
    tailnetMenu: (s: { provider: unknown; connection?: { connected: boolean }; url?: string | null }) => TailnetState;
};
const SERVE = JSON.stringify({
    TCP: { "8443": { HTTPS: true } },
    Web: { "papy.tail.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7777" }, "/aiball": { Proxy: "http://127.0.0.1:7777" } } } },
});

test("the tailnet module stays loadable outside the shell (no gi:// or resource:// import)", () => {
    assert.doesNotMatch(stripComments(readFileSync(TAILNET_FILE, "utf8")), /gi:\/\/|resource:\/\//);
});

test("the tailnet URL is the handler proxying to the board, on the configured path", () => {
    assert.equal(tailnet.aiballTailnetUrl(SERVE, 7777, "/aiball"), "https://papy.tail.ts.net:8443/aiball");
    assert.equal(tailnet.aiballTailnetUrl(SERVE, 7777, undefined), "https://papy.tail.ts.net:8443/");
    assert.equal(tailnet.aiballTailnetUrl(SERVE, 7878, "/aiball"), null, "a handler to another port is not the board");
    const on443 = JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "papy.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7777" } } } } });
    assert.equal(tailnet.aiballTailnetUrl(on443, 7777, "/"), "https://papy.tail.ts.net/", "the default port is left out");
    for (const junk of ["", "not json", "{}", null]) assert.equal(tailnet.aiballTailnetUrl(junk, 7777, "/"), null);
});

test("tailscale counts as connected only when it is Running", () => {
    assert.deepEqual(
        tailnet.tailscaleConnection(JSON.stringify({ BackendState: "Running", Self: { DNSName: "papy.tail.ts.net." } })),
        { connected: true, host: "papy.tail.ts.net" },
    );
    for (const s of [JSON.stringify({ BackendState: "Stopped" }), JSON.stringify({ BackendState: "NeedsLogin" }), "", null]) {
        assert.equal(tailnet.tailscaleConnection(s).connected, false, String(s));
    }
});

test("the section: hidden without a provider, Expose only when it can change something, no command that takes it down", () => {
    const provider = { enabled: true };
    assert.equal(tailnet.tailscaleProvider(JSON.stringify({ config: {}, tailscale: null })), null);
    assert.deepEqual(tailnet.tailscaleProvider(JSON.stringify({ config: { tailscale: provider } })), provider);
    assert.equal(tailnet.tailnetMenu({ provider: null }).visible, false);
    const served = tailnet.tailnetMenu({ provider, connection: { connected: true }, url: "https://x/aiball" });
    assert.equal(served.url, "https://x/aiball");
    assert.equal(served.canExpose, false);
    assert.equal(tailnet.tailnetMenu({ provider, connection: { connected: true }, url: null }).canExpose, true);
    assert.equal(tailnet.tailnetMenu({ provider, connection: { connected: false }, url: null }).canExpose, false);
    assert.equal(tailnet.tailnetMenu({ provider: { enabled: false }, connection: { connected: true }, url: null }).canExpose, false);
    const argv = Object.values(tailnet.TAILNET).flat();
    assert.ok(!argv.some((a) => a === "down" || a === "reset"), "one stray click must not wipe the machine's serve config");
    assert.deepEqual(tailnet.TAILNET.expose, ["aiball", "providers", "up", "--all"]);
});

test("the installers offer the extension on GNOME only, ask in a terminal, and refresh an existing install", () => {
    const base = { desktop: "GNOME", hasCli: true, installed: false, interactive: true };
    assert.equal(gnomeExtensionOffer(base), "ask");
    assert.equal(gnomeExtensionOffer({ ...base, interactive: false }), "hint");
    assert.equal(gnomeExtensionOffer({ ...base, desktop: "ubuntu:GNOME" }), "ask");
    assert.equal(gnomeExtensionOffer({ ...base, desktop: "KDE" }), "not-gnome");
    assert.equal(gnomeExtensionOffer({ ...base, desktop: undefined }), "not-gnome");
    assert.equal(gnomeExtensionOffer({ ...base, hasCli: false }), "not-gnome");
    assert.equal(gnomeExtensionOffer({ ...base, installed: true }), "refresh");
    assert.equal(gnomeExtensionOffer({ ...base, choice: false }), "declined");
    assert.equal(gnomeExtensionOffer({ ...base, desktop: "KDE", choice: true }), "install", "an explicit yes wins");
});

test("enabling appends the uuid to enabled-extensions once", () => {
    assert.equal(enabledExtensionsWith("@as []\n", "a@b"), "['a@b']");
    assert.equal(enabledExtensionsWith("['x@y', 'z@w']\n", "a@b"), "['x@y', 'z@w', 'a@b']");
    assert.equal(enabledExtensionsWith("['x@y', 'a@b']", "a@b"), null);
});

after(() => {
    for (const d of targets) rmSync(d, { recursive: true, force: true });
});
