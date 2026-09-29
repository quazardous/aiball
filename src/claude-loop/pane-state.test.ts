// #345 B — interrupted-pane detector (`[idle:interrupted]` decoration).
// node:test + tsx. Run: `npm test`.
//
// NB: Claude Code's exact string is still to be confirmed (#345 / #360); these
// tests lock the LOGIC (scope window + case-insensitivity + busy exclusion)
// against the assumed "interrupted by user" marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPaneSpecial, paneShowsInterrupted, snapshotPane } from "./state.js";

const prompt = "────────────\n❯ \n────────────\n  ⏵⏵ auto mode on";

test("detects 'Interrupted by user' near the prompt", () => {
    assert.equal(paneShowsInterrupted(`● doing stuff\n  ⎿ Interrupted by user\n${prompt}`), true);
});

test("detects 'Request interrupted by user' (contains the marker)", () => {
    assert.equal(paneShowsInterrupted(`[Request interrupted by user]\n${prompt}`), true);
});

test("case-insensitive", () => {
    assert.equal(paneShowsInterrupted(`INTERRUPTED BY USER\n${prompt}`), true);
});

test("pane busy (esc to interrupt) is NOT interrupted", () => {
    assert.equal(paneShowsInterrupted("✽ Working…\n  ⏵⏵ auto mode on · esc to interrupt"), false);
});

test("pane idle normal → false", () => {
    assert.equal(paneShowsInterrupted(prompt), false);
});

test("marker too far up the scrollback (out of the window) → false", () => {
    const old = "  ⎿ Interrupted by user";
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(paneShowsInterrupted(`${old}\n${filler}\n${prompt}`), false);
});

test("window counts NON-empty lines", () => {
    // 12 non-empty lines by default: the marker at the 11th non-empty position
    // (going up) stays seen despite interleaved blank lines.
    const blanks = "\n\n\n\n\n";
    assert.equal(paneShowsInterrupted(`  ⎿ Interrupted by user${blanks}\na\nb\nc\nd\ne\nf\ng`), true);
});

// #577 — classifyPaneSpecial must be footer-scoped (#B.185 fix applied).
// Without that, a `✶ Compacting conversation… (42s)` lingering in the scrollback
// after a finished `/compact` stays matched and blocks every wake forever.

// #650 david `tjab9e` — the classification requires the text "Compacting
// conversation" + at least one "live" signal among: Unicode progress bar
// (▰/▱), percentage (NN%), or `esc to interrupt`. The real capture of the
// Claude UI shows progress + % (sometimes with no esc-to-interrupt
// visible). The stale "✶ Compacting conversation… (42s)" with neither
// progress nor % is filtered out. First attempt (esc-to-interrupt only) broke
// because the new compact formats have NO esc-to-interrupt in the footer.

test("classifyPaneSpecial: live compacting with NN% → 'compacting'", () => {
    const live = "● earlier output\n✶ Compacting conversation… 42%\n  ⏵⏵ auto mode on · esc to interrupt";
    assert.equal(classifyPaneSpecial(live), "compacting");
});

test("classifyPaneSpecial: David's real format (progress bar + %, no esc to interrupt) → 'compacting'", () => {
    // #650 david `tjab9e` capture: Unicode progress bar + percent in the
    // footer, no esc-to-interrupt. Must match.
    const real = "✽ Compacting conversation… (1m 12s)\n  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 55%";
    assert.equal(classifyPaneSpecial(real), "compacting");
});

test("classifyPaneSpecial: minimal format (text + progress bar only, no %) → 'compacting'", () => {
    // Intermediate variant: the Unicode progress bar is enough as a live
    // signal even if the percentage is not rendered yet (initial frame).
    const initial = "Compacting conversation… \n  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱";
    assert.equal(classifyPaneSpecial(initial), "compacting");
});

test("classifyPaneSpecial: 'Compacting' + esc to interrupt alone (no progress/%) → null", () => {
    // #678 david `y3s6a8`: `esc to interrupt` removed from the live signal
    // because it is the generic busy marker (in the footer of EVERY normal
    // turn via `⏵⏵ auto mode on … · esc to interrupt`). Paired with a
    // `Compacting` lingering in the scrollback, it would misclassify every
    // normal turn after /compact. Only the progress bar (`▰▱`) or `NN%`
    // tell a live compact apart. This isolated legacy format (no progress
    // nor %) is no longer detected — acceptable, not seen in the current
    // claude UI.
    const legacyIsolated = "● earlier output\n✶ Compacting conversation… (12s)\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(legacyIsolated), null);
});

test("classifyPaneSpecial: real format #678 — Compacting outside footer-5, progress bar inside → 'compacting'", () => {
    // #678 david `y3s6a8`: real capture of an active /compact where the
    // separator box around the prompt + the auto-mode line below push the
    // text "Compacting conversation" beyond the 5-line footer. The live
    // signal (progress bar `▰▱` + percentage `28%`) stays right in the footer.
    // The detector MUST find the text on the whole pane and the live
    // signal in the footer.
    const realCapture = [
        "● Nettoyé (hack retiré du repo + de la box).",
        "",
        "  Petit point à vérifier toi-même : ...",
        "",
        "✻ Crunched for 9s",
        "",
        "❯ /compact",
        "",
        "✢ Compacting conversation… (29s)",
        "  ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 28%",
        "",
        "─".repeat(80),
        "❯ ",
        "─".repeat(80),
        "",
        "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
    ].join("\n");
    assert.equal(classifyPaneSpecial(realCapture), "compacting");
});

test("classifyPaneSpecial: % and 'Compacting' on different lines → 'compacting'", () => {
    const multiline = "✶ Compacting conversation…\n  progress: 42%\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(multiline), "compacting");
});

test("classifyPaneSpecial: stale 'Compacting' in the scrollback (prompt back) → null", () => {
    // Reproduces the #577 scenario: /compact finished, the prompt is back.
    // The `prompt` helper has no %, no Unicode progress bar, no esc-to-
    // interrupt → every live signal fails → null.
    const stale = "✶ Compacting conversation… (42s)";
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    assert.equal(classifyPaneSpecial(`${stale}\n${filler}\n${prompt}`), null);
});

test("classifyPaneSpecial: stale 'Compacting' with (42s) alone in the footer → null", () => {
    // Same case but the stale line itself is in the footer (just it +
    // prompt). No live signal → null.
    const stale = "✶ Compacting conversation… (42s)\n────\n❯ \n  ⏵⏵ auto mode on";
    assert.equal(classifyPaneSpecial(stale), null);
});

test("classifyPaneSpecial: % without 'Compacting' (some other progress bar) → null", () => {
    const other = "Downloading model… 42%\n  esc to interrupt";
    assert.equal(classifyPaneSpecial(other), null);
});

test("classifyPaneSpecial: pane idle normal → null", () => {
    assert.equal(classifyPaneSpecial(prompt), null);
});

test("snapshotPane: stale 'Compacting' scrollback + prompt → busy:false special:null", () => {
    // Exact case from the #577 timer.log: `pane=busy:false special=compacting`
    // stuck on true because of the scrollback. After the fix: special:null.
    const stale = "✶ Compacting conversation… (42s)";
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const snap = snapshotPane(`${stale}\n${filler}\n${prompt}`);
    assert.equal(snap.busy, false);
    assert.equal(snap.special, null);
});

test("snapshotPane: live compacting (esc to interrupt + Compacting NN% in the footer) → busy:true special:'compacting'", () => {
    const live = "● earlier\n✶ Compacting conversation… 42%\n  ⏵⏵ auto mode on · esc to interrupt";
    const snap = snapshotPane(live);
    assert.equal(snap.busy, true);
    assert.equal(snap.special, "compacting");
});

test("snapshotPane: the barless format (12s · ↓ tokens) is compacting again (#3045)", () => {
    // #678 had dropped this variant (no progress bar): a stale `Compacting`
    // line in scrollback, plus the auto-mode footer's `esc to interrupt`, was a
    // lasting false positive. It said it would come back with a stricter
    // discriminant if the variant resurfaced — it did (#3045: Claude Code no
    // longer draws the bar). The discriminant is the spinner's token counter,
    // which only a running spinner carries, on a line in the footer.
    const live = "● earlier\n✶ Compacting conversation… (12s · ↓ 1.2k tokens)\n  ⏵⏵ auto mode on · esc to interrupt";
    const snap = snapshotPane(live);
    assert.equal(snap.busy, true);
    assert.equal(snap.special, "compacting");
    // The #678 false positive stays out: stale text without a counter.
    assert.equal(snapshotPane("● earlier\n✶ Compacting conversation… (12s)\n  ⏵⏵ auto mode on · esc to interrupt").special, null);
});
