/**
 * `aiball auth` works on this machine's database. On a proxy node that database
 * is not the one that counts — the hub's is — so `list` printed "(no tokens)"
 * on a working node and `issue` minted tokens no daemon accepted. On a node,
 * every `auth` subcommand now refuses and says where tokens live instead.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyNodeRefusal } from "./auth.js";

const BIN = join(import.meta.dirname, "..", "..", "bin", "aiball");
const DIR = mkdtempSync(join(tmpdir(), "aiball-auth-node-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

function aiball(args: string[], withProxy: boolean) {
    const config = join(DIR, withProxy ? "node" : "plain");
    mkdirSync(join(config, "aiball"), { recursive: true });
    if (withProxy) writeFileSync(join(config, "aiball", "config.yaml"), "proxy:\n  url: https://hub.example:8443\n  token: aiball-node\n");
    return spawnSync(process.execPath, [BIN, ...args], {
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: config, AIBALL_HOME: join(DIR, "home"), AIBALL_SOCK: "", AIBALL_TOKEN: "" },
    });
}

test("on a proxy node, every auth subcommand refuses and names the hub", () => {
    for (const args of [["auth", "list"], ["auth", "issue", "--consumer", "tvty"], ["auth", "revoke", "aiball-x"], ["auth", "init"], ["auth", "reinit"]]) {
        const r = aiball(args, true);
        assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
        assert.match(r.stderr, new RegExp(`auth ${args[1]}: this daemon is a proxy node for https://hub\\.example:8443`));
        assert.match(r.stderr, /aiball proxy token add --consumer <id> --remote <that token>/);
    }
});

test("without a proxy block, auth works on the local database as before", () => {
    const r = aiball(["auth", "list"], false);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\(no tokens\)/);
});

test("the refusal says what to do, for each way a client can authenticate", () => {
    const t = proxyNodeRefusal("https://hub:1", "issue");
    assert.match(t, /mint it on the hub/);
    assert.match(t, /aiball proxy token list/);
    assert.match(t, /relayed with this node's token/);
});
