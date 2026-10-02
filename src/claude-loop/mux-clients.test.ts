/**
 * #3477 — `list-clients -F …` read the same way for tmux and psmux: psmux
 * ignores `-F` (lines below as psmux 3.3.8 printed them for two clients, one
 * attached with `-r`), so its clients are counted but not told apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ignoresFormat, parseClientCounts, parseClientList } from "./mux-clients.js";

const PSMUX = "/dev/pts/4: probe-3477: 600 [120x29] (utf8) [activity=3s ago]\r\n/dev/pts/6: probe-3477: 600 [120x29] (utf8) [activity=3s ago]\r\n";

test("psmux's default line is told from an answer in the format asked", () => {
    assert.equal(ignoresFormat(PSMUX), true);
    assert.equal(ignoresFormat("0\n1\n"), false);
    assert.equal(ignoresFormat("/dev/pts/3 4242 0\n"), false, "a tmux client name is a tty too, without the default form");
    assert.equal(ignoresFormat(""), false);
});

test("counts: tmux says who has the controls; psmux only how many", () => {
    assert.deepEqual(parseClientCounts("0\n1\n0\n"), { clients: 3, interactive: 2 });
    assert.deepEqual(parseClientCounts(""), { clients: 0, interactive: 0 });
    assert.deepEqual(parseClientCounts(PSMUX), { clients: 2, interactive: null });
});

test("the client list: each client under tmux; null under psmux, which cannot tell them apart", () => {
    assert.deepEqual(parseClientList("/dev/pts/3 4242 0\n/dev/pts/5 4343 1\n"), [
        { client: "/dev/pts/3", pid: 4242, readonly: false },
        { client: "/dev/pts/5", pid: 4343, readonly: true },
    ]);
    assert.deepEqual(parseClientList(""), []);
    assert.equal(parseClientList(PSMUX), null);
});
