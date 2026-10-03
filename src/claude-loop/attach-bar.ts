/**
 * #3469 — the loop's bar for `claude-loop attach` on the session host, the same
 * as tmux's status line. In tmux mode the kernel writes the bar into tmux's
 * options and tmux draws it; on the host nothing drew it for this client, so a
 * human attached here saw no AFK, no countdown, no state, and F9 answered
 * nothing visible.
 *
 * Here the bar is rebuilt from the data the loop publishes (`agent.<id>.bar`)
 * into the snapshot the kernel paints from, turned into the same tmux options
 * by the same function (`barOptionValues`, `statusRightFormat`), then drawn:
 * tmux's `#[fg=…,bg=…]` styles become terminal colours. On the terminal's last
 * row, which Claude is kept out of (a scroll region, and one row less).
 */
import type { AgentBar } from "../agent-bar.js";
import { COPY_MARK } from "./bar-render.js";
import { barOptionValues, renderMarkerSegment, statusRightFormat, type BarColors, type BarOptions, type BarSnapshot } from "./bar-renderer.js";
import { formatAfkGlyph } from "./state.js";
import { denialChip } from "./denials.js";

/** The bar as the daemon serves it: the loop's facts, and whether its loop is gone. */
export interface AttachBarView {
    bar: AgentBar;
    stale: boolean;
}

/** What the right side says, fixed for the attach. */
export interface AttachBarSetup {
    colors: BarColors;
    /** The loop's name, as tmux's `@cl_name`. */
    name: string;
    /** The AFK key as shown (`F9`), or null when the loop has none (`AFK:OFF`). */
    afkKey: string | null;
    /** How to leave, as shown: attach's own keys. */
    detach: string;
    /** A read-only copy: the COPY mark at the head, as tmux shows it to a read-only client. */
    readonly: boolean;
}

const secondsUntil = (iso: string | null, nowMs: number): number | null => {
    if (!iso) return null;
    const ms = Date.parse(iso) - nowMs;
    return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : null;
};

/**
 * The snapshot the kernel would paint, from the published bar. A loop whose
 * kernel is gone (`stale`) shows the lost-link red, as a loop that lost its
 * daemon does.
 */
export function snapshotFromAgentBar(view: AttachBarView, nowMs: number, col: BarColors): BarSnapshot {
    const b = view.bar;
    const holdLeft = b.afk.mode === "wait_10m" ? secondsUntil(b.afk.expires_at, nowMs) : null;
    const held = b.afk.mode === "wait_inf" || holdLeft !== null;
    const afkChunk = b.afk.mode === "wait_inf" ? { color: "red" as const, prefix: "∞" }
        : holdLeft !== null ? { color: "yellow" as const, prefix: `${Math.max(1, holdLeft)}s` }
        : { color: "dim" as const, prefix: null };
    const booting = b.phase === "boot";
    const bootStarted = b.boot ? Date.parse(b.boot.started_at) : NaN;
    return {
        humanWord: booting ? "" : ` #[fg=${held ? "colour178" : "colour40"},bg=colour16]${held ? "⏸" : "▶"}`,
        loopStatus: b.phase,
        stateTag: renderMarkerSegment(b.phase, b.marker.info, b.marker.health_prompt, b.marker.resume_picker, b.marker.resume_mode_picker),
        proxyAlive: b.proxy_alive,
        zenActive: b.zen,
        counters: b.counters,
        nextWakeInSec: b.phase === "idle" ? secondsUntil(b.next_wake_at, nowMs) : null,
        denialChip: denialChip(b.denials, nowMs),
        bootElapsedSec: booting && Number.isFinite(bootStarted) ? Math.max(0, Math.floor((nowMs - bootStarted) / 1000)) : null,
        bootRemainingSec: booting ? secondsUntil(b.boot?.deadline_at ?? null, nowMs) : null,
        afkGlyph: formatAfkGlyph(afkChunk),
        promptGlyph: b.prompt.visible ? (b.prompt.has_input ? `#[fg=${col.prompt_input_fg}]❯#[fg=${col.island_fg}]` : "❯") : "",
        typingGlyph: b.human_typing ? "#[fg=colour196,bg=colour16]⌨" : "",
        linkDown: b.alerts.link_down || view.stale,
        daemonDown: b.alerts.daemon_down,
        notLoggedIn: b.alerts.not_logged_in,
        limitReached: b.alerts.limit_reached,
        limitResetsText: b.limit_resets?.text ?? null,
        trustDialog: b.alerts.trust_dialog,
        apiUnreachable: b.alerts.api_unreachable,
    };
}

/** The COPY mark as tmux shows it to a read-only client (its `#,` are commas), or nothing. */
function copyMark(readonly: boolean, detach: string): string {
    if (!readonly) return "";
    const inner = COPY_MARK.slice("#{?client_readonly,".length, -",}".length);
    return inner.replace(/#,/g, ",").replace("#{prefix} d", detach);
}

/** The `#{@cl_*}` a format refers to, with the options' values; `#{@cl_name}` the loop's. */
export function expandFormat(format: string, opts: BarOptions, setup: AttachBarSetup): string {
    return format
        .replace(COPY_MARK, copyMark(setup.readonly, setup.detach))
        .replace(/#\{@(cl_[a-z_]+)\}/g, (_, key: string) => (key === "cl_name" ? setup.name : (opts as unknown as Record<string, string>)[`@${key}`] ?? ""));
}

const NAMED: Record<string, number> = { black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7 };

/** A tmux colour as the SGR parameters that set it: `fg` 38…, `bg` 48…; `default` the terminal's. */
function sgrColour(colour: string, layer: "fg" | "bg"): string {
    const base = layer === "fg" ? 38 : 48;
    const c = colour.trim().toLowerCase();
    const indexed = /^colou?r(\d{1,3})$/.exec(c);
    if (indexed) return `${base};5;${indexed[1]}`;
    const hex = /^#([0-9a-f]{6})$/.exec(c);
    if (hex) return `${base};2;${parseInt(hex[1]!.slice(0, 2), 16)};${parseInt(hex[1]!.slice(2, 4), 16)};${parseInt(hex[1]!.slice(4, 6), 16)}`;
    const bright = /^bright(\w+)$/.exec(c);
    if (bright && NAMED[bright[1]!] !== undefined) return `${base};5;${NAMED[bright[1]!]! + 8}`;
    if (NAMED[c] !== undefined) return `${base};5;${NAMED[c]}`;
    return layer === "fg" ? "39" : "49";
}

/** Columns a character takes: two for an emoji shown as one, and for Hangul / CJK (`웃`). */
export function cellsOf(ch: string): number {
    return /\p{Emoji_Presentation}|[\u{1F441}ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/u.test(ch) ? 2 : 1;
}

/**
 * A tmux format, its `#[…]` styles turned into terminal colours, over the
 * status line's own (`default` goes back to them). Cut to `max` columns; how
 * many it takes.
 */
export function tmuxToAnsi(format: string, statusFg: string, statusBg: string, max: number): { text: string; cells: number } {
    let fg = statusFg;
    let bg = statusBg;
    let bold = false;
    const sgr = () => `\x1b[0;${bold ? "1;" : ""}${sgrColour(fg, "fg")};${sgrColour(bg, "bg")}m`;
    let text = sgr();
    let cells = 0;
    let i = 0;
    while (i < format.length) {
        if (format.startsWith("#[", i)) {
            const end = format.indexOf("]", i);
            if (end < 0) break;
            for (const attr of format.slice(i + 2, end).split(",")) {
                const a = attr.trim();
                if (a.startsWith("fg=")) fg = a.slice(3) === "default" ? statusFg : a.slice(3);
                else if (a.startsWith("bg=")) bg = a.slice(3) === "default" ? statusBg : a.slice(3);
                else if (a === "bold") bold = true;
                else if (a === "nobold") bold = false;
                else if (a === "default" || a === "none") { fg = statusFg; bg = statusBg; bold = false; }
            }
            text += sgr();
            i = end + 1;
            continue;
        }
        if (format.startsWith("##", i)) { i += 1; }
        const ch = String.fromCodePoint(format.codePointAt(i)!);
        const w = cellsOf(ch);
        if (cells + w > max) break;
        text += ch;
        cells += w;
        i += ch.length;
    }
    return { text, cells };
}

/** tmux's own limits for the two sides (`status-left-length`, `status-right-length`). */
const LEFT_MAX = 90;
const RIGHT_MAX = 60;

/**
 * The row to write: saved cursor, the bar on `rows` (left side, right side
 * against the edge, the status colour between), cursor back, so Claude's screen
 * is untouched. With no bar from the loop yet, says so.
 */
export function attachBarRow(rows: number, cols: number, view: AttachBarView | null, nowMs: number, setup: AttachBarSetup): string {
    const at = `\x1b7\x1b[${rows};1H`;
    const back = "\x1b[0m\x1b8";
    if (!view) {
        const { text } = tmuxToAnsi(`${copyMark(setup.readonly, setup.detach)} waiting for the loop's bar`, setup.colors.bar_fg, "colour240", cols);
        return `${at}${text}\x1b[K${back}`;
    }
    const opts = barOptionValues(snapshotFromAgentBar(view, nowMs, setup.colors), setup.colors);
    const fg = opts["status-fg"];
    const bg = opts["status-bg"];
    const left = tmuxToAnsi(expandFormat(opts["status-left"], opts, setup), fg, bg, Math.min(LEFT_MAX, cols));
    const fill = tmuxToAnsi("", fg, bg, 0).text;
    let row = `${at}${fill}\x1b[K${left.text}`;
    const room = cols - left.cells;
    if (room > 1) {
        const right = tmuxToAnsi(expandFormat(statusRightFormat(setup.colors, setup.afkKey, setup.detach), opts, setup), fg, bg, Math.min(RIGHT_MAX, room - 1));
        row += `\x1b[${rows};${cols - right.cells + 1}H${right.text}`;
    }
    return `${row}${back}`;
}

/** Keep Claude's output above the bar: scrolling stays within rows 1 … rows-1. */
export const scrollRegion = (rows: number): string => `\x1b7\x1b[1;${Math.max(1, rows - 1)}r\x1b8`;

/** The whole screen scrolls again, as on leaving. */
export const RESET_SCROLL_REGION = "\x1b[r";
