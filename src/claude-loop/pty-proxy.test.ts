// #360 — couche détection du PTY-proxy, testée HORS tmux via son mode `--replay`.
//
// Le proxy est du Python (zéro-dép, #269) ; sa logique frappe→action est isolée
// dans le cœur PUR `_Decider` (pty-proxy.py) et rejouable par `pty-proxy.py
// --replay`, qui émet un verdict NDJSON par event. On teste donc le VRAI code
// du proxy (pas un mirror TS) en lui pipant des séquences chronométrées —
// pendant que `afk-key.test.ts` couvre le parser de combos côté TS.
//
// node:test + tsx. Run: `npm test`. (Skip propre si python3 absent.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "pty-proxy.py");
const PY = "python3";

/** python3 dispo ? Le proxy en a besoin au runtime ; sans lui on skip. */
function hasPython(): boolean {
    try {
        return spawnSync(PY, ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
        return false;
    }
}
const SKIP = !hasPython();

interface Verdict {
    event: string;
    raw: string;
    forward: string;
    buffer: string | null;
    markers: string[];
    word: string | null;
    afk_fired: boolean;
    typing: boolean;
    lone_esc: boolean;
    buffered_first: boolean;
    afk_active: boolean;
    word_resolved: string | null;
}

/**
 * Rejoue `seq` (lignes `<delay_ms> <token>`) à travers le vrai proxy et rend
 * le tableau des verdicts NDJSON. `afkSpec` = combos AFK (JSON, ex.
 * `[[27],[27]]` pour `esc esc`), `windowMs` = fenêtre 2-combos.
 */
function replay(seq: string, afkSpec: string, windowMs = 400): Verdict[] {
    const r = spawnSync(PY, [PROXY, "--replay"], {
        input: seq,
        encoding: "utf8",
        env: {
            ...process.env,
            CL_AFK_SPEC: afkSpec,
            CL_AFK_WINDOW_MS: String(windowMs),
            CL_ESC_TAKEOVER: "1",
            CL_USER_GRACE_SEC: "60",
        },
    });
    assert.equal(r.status, 0, `--replay exit ${r.status}: ${r.stderr}`);
    return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Verdict);
}

const ESC_ESC = "[[27],[27]]"; // afk_key "esc esc" (cf. afk-key.test.ts)
const ALT_ESC = "[[27,27]]";   // afk_key "alt+esc" (combo atomique, 1 read)

// ---- esc esc : combo en DEUX reads (cas nominal) -------------------------

test("esc esc en deux frappes (dans la fenêtre) → AFK armé sur la 2e", { skip: SKIP }, () => {
    const v = replay("0 esc\n100 esc\n", ESC_ESC);
    assert.equal(v.length, 2);
    // 1re ESC : bufferisée (pas forwardée), présence armée, PAS encore afk.
    // #381 : surtout PAS de clear_afk ici (1er octet ambigu) — c'était le bug.
    assert.equal(v[0].buffered_first, true);
    assert.equal(v[0].afk_fired, false);
    assert.equal(v[0].forward, "");
    assert.deepEqual(v[0].markers, ["touch_user_grace"]);
    // 2e ESC : le combo réussit → set_afk, rien forwardé (ni rewind ni interruption).
    assert.equal(v[1].afk_fired, true);
    assert.equal(v[1].afk_active, true);
    assert.equal(v[1].forward, "");
    assert.ok(v[1].markers.includes("set_afk"));
});

// ---- #381 : esc esc est un VRAI toggle (on↔off), une seule pression inerte ---
test("#381: esc esc TOGGLE on↔off, et un esc seul ne change PAS l'afk", { skip: SKIP }, () => {
    // esc esc (on) → esc esc (off) → esc seul + flush (inchangé).
    const v = replay("0 esc\n100 esc\n2000 esc\n100 esc\n2000 esc\n500 -\n", ESC_ESC);
    const fired = v.filter((r) => r.afk_fired);
    assert.equal(fired.length, 2);
    assert.equal(fired[0].afk_active, true);   // 1er combo → ON
    assert.equal(fired[1].afk_active, false);  // 2e combo → OFF (toggle, plus seulement set)
    // dernier event = l'esc seul (flushé) : afk reste OFF, aucune mutation afk.
    const last = v.at(-1)!;
    assert.equal(last.afk_active, false);
    assert.equal(v.filter((r) => r.markers.includes("clear_afk")).length, 1); // SEUL le 2e combo clear
});

test("esc seul puis tick au-delà de la fenêtre → flush vers claude, PAS d'AFK", { skip: SKIP }, () => {
    const v = replay("0 esc\n500 -\n", ESC_ESC);
    assert.equal(v[0].buffered_first, true);
    assert.equal(v[0].afk_fired, false);
    // flush différé : l'ESC nu finit par atteindre claude (interruption retardée).
    assert.equal(v[1].event, "flush");
    assert.equal(v[1].forward, "1b");
    assert.equal(v.at(-1)!.afk_active, false);
});

test("2e ESC hors fenêtre → ré-arme au lieu de fire (besoin de 2 rapprochés)", { skip: SKIP }, () => {
    const v = replay("0 esc\n800 esc\n", ESC_ESC);
    assert.equal(v[0].afk_fired, false);
    assert.equal(v[1].afk_fired, false);       // fenêtre expirée → simple ré-arme
    assert.equal(v[1].buffered_first, true);
});

// ---- #381 : esc esc COALESCÉ en un seul read → déterministe ------------------
// Quand le terminal livre les deux ESC d'un coup (`1b1b`), le combo `esc esc`
// les reconnaît comme la concaténation → toggle, au lieu de l'ancien
// non-déterminisme (traité en ESC nu selon le batching). Plus rien ne part à
// claude. C'est la moitié « armement qui se corrompt parfois » de #381.
test("#381: esc esc coalescé en un read → toggle l'AFK (déterministe)", { skip: SKIP }, () => {
    const v = replay("0 1b1b\n", ESC_ESC);
    assert.equal(v.length, 1);
    assert.equal(v[0].afk_fired, true);
    assert.equal(v[0].afk_active, true);
    assert.equal(v[0].forward, "");           // rien ne fuit vers claude
});

// ---- alt+esc : combo ATOMIQUE robuste au batching ---------------------------
// `[[27,27]]` est UN combo de 2 octets → un seul read `1b1b` le matche →
// armement déterministe (recommandation #345 face à l'ambiguïté de `esc esc`).
test("alt+esc (combo atomique) → un seul read 1b1b arme l'AFK", { skip: SKIP }, () => {
    const v = replay("0 1b1b\n", ALT_ESC);
    assert.equal(v[0].afk_fired, true);
    assert.equal(v[0].afk_active, true);
    assert.equal(v[0].forward, "");
});

// ---- frappe ordinaire -------------------------------------------------------

test("frappe texte ordinaire → typing, forward, mot stop", { skip: SKIP }, () => {
    const v = replay("0 61\n", ESC_ESC);       // 'a'
    assert.equal(v[0].typing, true);
    assert.equal(v[0].forward, "61");
    assert.equal(v[0].word_resolved, "stop");
    assert.ok(v[0].markers.includes("touch_user_grace"));
});

test("frappe ordinaire APRÈS afk → clear_afk (toute activité = retour humain)", { skip: SKIP }, () => {
    // esc esc (afk on) puis 'a' → l'AFK se lève.
    const v = replay("0 esc\n100 esc\n2000 61\n", ESC_ESC);
    assert.equal(v[1].afk_active, true);       // afk on après le combo
    assert.equal(v.at(-1)!.afk_active, false); // 'a' l'a clear
    assert.ok(v.at(-1)!.markers.includes("clear_afk"));
});
