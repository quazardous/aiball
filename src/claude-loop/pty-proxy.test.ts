// #360 / #381 — couche détection du PTY-proxy, testée HORS tmux via `--replay`.
//
// Le proxy est du Python (zéro-dép, #269) ; sa logique frappe→action est isolée
// dans le cœur PUR `_Decider` (pty-proxy.py) et rejouable par `pty-proxy.py
// --replay`, qui émet un verdict NDJSON par event. On teste donc le VRAI code
// du proxy (pas un mirror TS).
//
// #381 (david s4r9n8 « on laisse tomber les fenêtres avec timing — seul les
// combinaisons comptent ») : l'AFK est désormais un COMBO ATOMIQUE unique
// (chord) qui TOGGLE ; plus de séquence à 2 touches avec fenêtre. Le seul
// timing restant est un debounce post-fire (key-repeat d'un chord maintenu).
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
 * `[[27,97]]` pour `alt+a`), `windowMs` = debounce key-repeat post-fire.
 */
function replay(seq: string, afkSpec: string, windowMs = 400, extraEnv: Record<string, string> = {}): Verdict[] {
    const r = spawnSync(PY, [PROXY, "--replay"], {
        input: seq,
        encoding: "utf8",
        env: {
            ...process.env,
            // #629 `jf6efv` — explicitly DEFAULT to --wait so tests don't
            // inherit the env of a parent claude-loop session running
            // under --no-wait (which would silently flip the AFK-on-typing
            // semantics). Tests for the --no-wait branch pass `CL_WAIT: "0"`.
            CL_WAIT: "",
            // Force boot grace to 0 so `_boot_grace_remaining()` always
            // returns 0 → `in_boot=False` deterministically. Without this
            // the test depends on real wall-clock vs proxy start time, and
            // any test running within 60s of process start would see the
            // "in_boot" branch fire (no arm_afk_10m), breaking assertions
            // that target the post-boot behavior.
            CL_BOOT_GRACE_SEC: "0",
            CL_AFK_SPEC: afkSpec,
            CL_AFK_WINDOW_MS: String(windowMs),
            CL_ESC_TAKEOVER: "1",
            CL_USER_GRACE_SEC: "60",
            ...extraEnv,
        },
    });
    assert.equal(r.status, 0, `--replay exit ${r.status}: ${r.stderr}`);
    return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Verdict);
}

const ALT_A = "[[27,97]]";   // afk_key "alt+a"   → ESC a    (combo atomique 2 octets)
const CTRL_G = "[[7]]";      // afk_key "ctrl+g"  → 0x07     (combo atomique 1 octet)
const ALT_ESC = "[[27,27]]"; // afk_key "alt+esc" → ESC ESC  (défaut #d3me34)

// ---- combo atomique : un appui = un TOGGLE ---------------------------------

test("combo unique → TOGGLE ON, rien forwardé à claude", { skip: SKIP }, () => {
    const v = replay("0 1b61\n", ALT_A);
    assert.equal(v.length, 1);
    assert.equal(v[0].afk_fired, true);
    assert.equal(v[0].afk_active, true);
    assert.equal(v[0].forward, "");            // le combo est avalé
    // #622 jzcgmh : F9 = pure 2-state toggle, emits `toggle_afk`.
    assert.ok(v[0].markers.includes("toggle_afk"));
});

test("combo x2 → ON puis OFF (vrai toggle)", { skip: SKIP }, () => {
    const v = replay("0 1b61\n500 1b61\n", ALT_A);
    assert.equal(v[0].afk_active, true);
    assert.equal(v[1].afk_active, false);
    assert.equal(v.map((r) => r.forward).join(""), "");
});

// ---- debounce key-repeat : un chord MAINTENU ne toggle qu'une fois ----------

test("key-repeat du combo dans UN read → UN seul toggle (2e avalé)", { skip: SKIP }, () => {
    const v = replay("0 1b611b61\n", ALT_A);   // alt+a alt+a coalescé
    assert.equal(v.length, 2);                  // re-séparé en 2 touches
    assert.equal(v[0].afk_fired, true);
    assert.equal(v[1].afk_fired, false);        // 2e avalé par le debounce
    assert.equal(v.at(-1)!.afk_active, true);
    assert.equal(v.map((r) => r.forward).join(""), "");
});

test("key-repeat sur reads séparés, dans le debounce → un seul toggle", { skip: SKIP }, () => {
    const v = replay("0 1b61\n50 1b61\n50 1b61\n", ALT_A);
    const fired = v.filter((r) => r.afk_fired);
    assert.equal(fired.length, 1);
    assert.equal(v.at(-1)!.afk_active, true);
});

// ---- ESC reste une interruption PURE et INSTANTANÉE -------------------------
// #381 : plus de buffering (la séquence à 2 a disparu) → un ESC nu atteint
// claude IMMÉDIATEMENT, sans le délai de 400ms de l'ancien buffer, et ne touche
// pas l'afk (le combo n'est plus basé sur ESC).
test("ESC seul → forwardé MAINTENANT, aucun toggle, afk inchangé", { skip: SKIP }, () => {
    const v = replay("0 esc\n", ALT_A);
    assert.equal(v.length, 1);
    assert.equal(v[0].event, "stdin");
    assert.equal(v[0].forward, "1b");          // pas de flush différé
    assert.equal(v[0].afk_fired, false);
    assert.equal(v[0].lone_esc, true);
});

// ---- frappe ordinaire -------------------------------------------------------

test("frappe texte ordinaire → typing, forward, mot stop", { skip: SKIP }, () => {
    const v = replay("0 61\n", ALT_A);          // 'a'
    assert.equal(v[0].typing, true);
    assert.equal(v[0].forward, "61");
    assert.equal(v[0].word_resolved, "stop");
    assert.ok(v[0].markers.includes("touch_user_grace"));
});

test("frappe sous --no-wait → STOP flash mais PAS d'arm AFK 10m (jf6efv)", { skip: SKIP }, () => {
    // #629 david `jf6efv` — under --no-wait, the loop is autonomous : typing
    // must NOT auto-engage NOT AFK. Picker-selection keystrokes (or any
    // post-boot typing) used to systematically land the bar in `wait` jaune
    // right after boot, contradicting --no-wait's intent.
    const v = replay("0 61\n", ALT_A, 400, { CL_WAIT: "0" });
    assert.equal(v[0].typing, true);
    assert.equal(v[0].forward, "61");
    assert.equal(v[0].word_resolved, "stop");
    // Touch markers fired (bar STOP flash + user-grace silently for wakes)…
    assert.ok(v[0].markers.includes("touch_marker"));
    assert.ok(v[0].markers.includes("touch_user_grace"));
    // … but arm_afk_10m did NOT fire (the bar won't drift to `wait` once
    // the typing flash dissipates). F9 stays the only path to NOT AFK.
    assert.ok(!v[0].markers.includes("arm_afk_10m"));
});

test("frappe ordinaire APRÈS afk ∞ → no-op (only F9 peut release l'∞)", { skip: SKIP }, () => {
    // #622 jzcgmh : combo (NOT AFK ∞) puis 'a' (typing). En ∞, typing
    // est un no-op pour l'AFK (`arm_afk_10m` retourne sans rien faire
    // si mode == "inf"). Le marker est émis mais l'effet est nul. Le
    // simulateur de replay (n'ayant pas accès au "vrai" mode du fichier)
    // applique le marker comme "set active" — c'est suffisant pour la
    // sémantique : l'AFK reste actif après typing en ∞.
    const v = replay("0 1b61\n2000 61\n", ALT_A);
    assert.equal(v[0].afk_active, true);                       // combo → NOT AFK ∞
    assert.equal(v.at(-1)!.afk_active, true);                  // typing → reste actif
    assert.ok(v.at(-1)!.markers.includes("arm_afk_10m"));
    assert.ok(!v.at(-1)!.markers.includes("clear_afk"));       // plus de clear sur typing
});

// ---- split combo-aware : combo détaché du texte coalescé --------------------

test("texte 'x' + combo coalescés (781b61) → 'x' forwardé, combo toggle", { skip: SKIP }, () => {
    const v = replay("0 781b61\n", ALT_A);
    assert.equal(v.length, 2);
    assert.equal(v[0].forward, "78");           // 'x' passe à claude
    assert.equal(v[1].afk_fired, true);         // alt+a détaché → toggle
    assert.equal(v[1].forward, "");
});

// ---- les flèches (CSI) survivent au split ----------------------------------
test("flèche ESC[A non disloquée par le split → forwardée intacte", { skip: SKIP }, () => {
    const v = replay("0 1b5b41\n", ALT_A);
    assert.equal(v.length, 1);
    assert.equal(v[0].raw, "1b5b41");
    assert.equal(v[0].afk_fired, false);
    assert.equal(v[0].forward, "1b5b41");
});

// ---- combo 1 octet (ctrl+g) -------------------------------------------------
test("ctrl+g (combo 1 octet 0x07) → toggle, rien forwardé", { skip: SKIP }, () => {
    const v = replay("0 07\n", CTRL_G);
    assert.equal(v[0].afk_fired, true);
    assert.equal(v[0].afk_active, true);
    assert.equal(v[0].forward, "");
});

// ---- alternatives : plusieurs combos, n'importe lequel toggle ---------------
test("alternatives (ctrl+g OU alt+a) : chacun toggle", { skip: SKIP }, () => {
    const SPEC = "[[7],[27,97]]";
    const v = replay("0 07\n2000 1b61\n", SPEC);   // ctrl+g (on) puis alt+a (off)
    assert.equal(v[0].afk_active, true);
    assert.equal(v[1].afk_active, false);
    assert.equal(v.map((r) => r.forward).join(""), "");
});

// ---- alt+esc (défaut #d3me34) : 1b1b atomique --------------------------------
// alt+esc = octets ESC ESC. Contrat voulu par david : un SEUL ESC (le bug
// rapporté) ne toggle PAS et reste une interruption ; le combo 1b1b toggle ;
// un ESC en key-repeat (1b1b…) ne fait qu'UN toggle (debounce). NB : 1b1b est
// byte-identique à un double-ESC mashé coalescé — collision documentée.
test("alt+esc: un seul ESC ne toggle PAS, reste forwardé (interruption)", { skip: SKIP }, () => {
    const v = replay("0 1b\n", ALT_ESC);
    assert.equal(v.length, 1);
    assert.equal(v[0].afk_fired, false);
    assert.equal(v[0].forward, "1b");
});

test("alt+esc: 1b1b atomique → toggle, rien forwardé", { skip: SKIP }, () => {
    const v = replay("0 1b1b\n", ALT_ESC);
    assert.equal(v.at(-1)!.afk_fired, true);
    assert.equal(v.at(-1)!.afk_active, true);
    assert.equal(v.map((r) => r.forward).join(""), "");
});

test("alt+esc: ESC key-repeat (1b1b1b) → UN seul toggle (debounce)", { skip: SKIP }, () => {
    const v = replay("0 1b1b1b\n", ALT_ESC);
    const fired = v.filter((r) => r.afk_fired);
    assert.equal(fired.length, 1);
    assert.equal(v.at(-1)!.afk_active, true);
});

// ---- #381 (david) : l'armement ne se "corrompt" PAS sur usage répété --------
// Bug rapporté : « la 1re fois esc esc toggle, mais après une seule pression
// suffit (armement cassé) ». Régression : un ESC NU, quel que soit l'état afk
// antérieur, ne FIRE jamais le combo — il reste une interruption forwardée. Le
// combo atomique 1b1b est la SEULE chose qui toggle.
test("alt+esc: armement non corrompu — un ESC nu APRÈS un toggle ne re-fire pas le combo (#381)", { skip: SKIP }, () => {
    const v = replay("0 1b1b\n2000 1b\n", ALT_ESC);
    // le combo 1b1b toggle ON…
    assert.equal(v[0].afk_fired, true);
    assert.equal(v[0].afk_active, true);
    assert.equal(v[0].forward, "");
    // …puis un ESC nu ne re-fire PAS le combo (armement intact) : il est forwardé
    // comme une interruption, pas avalé par un faux match du combo.
    assert.equal(v[1].afk_fired, false);
    assert.equal(v[1].forward, "1b");
    assert.equal(v[1].lone_esc, true);
});

// #381 : deux ESC nus sur des reads SÉPARÉS ne se recombinent pas en 1b1b
// (combos atomiques, aucune fenêtre cross-read) — garde contre un armement qui
// "s'armerait" à travers deux frappes successives.
test("alt+esc: deux ESC nus séparés ne togglent pas (pas de combo cross-read) (#381)", { skip: SKIP }, () => {
    const v = replay("0 1b\n100 1b\n", ALT_ESC);
    assert.equal(v.length, 2);
    assert.ok(v.every((r) => r.afk_fired === false), "aucun ESC nu ne doit fire le combo");
    assert.equal(v.map((r) => r.forward).join(""), "1b1b");
});
