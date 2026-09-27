/**
 * #3128 — an agent's screen on the bus, for the web terminal: the subject
 * `agent.<id>.screen` follows it wherever Claude runs (src/pane-screen.ts),
 * and `agent.pane_keys` / `agent.pane_resize` type into it. A human's view:
 * typing into a live session, or watching one, is not an agent's gesture.
 */
import { z } from "zod";
import { consumerIdOf, defineMethod, Refusal, type Caller } from "../methods.js";
import { defineSubject, sendTo, type Subscription } from "../subscriptions.js";
import { ERROR_CODES } from "../../domain.js";
import { keysWithoutScreen, MAX_KEYS_BYTES, openScreen, screenSourceOf, type Screen, type Size } from "../../pane-screen.js";

const HUMAN = {
    who: ["human"] as const,
    denied: { message: "an agent's screen is a human's view", code: ERROR_CODES.MODERATOR_ONLY },
};

/** The screens open on this daemon, by whoever opened them and for which agent. */
const open = new Map<string, Set<Screen>>();
const keyOf = (consumer: string, agent: string) => `${consumer}\u0000${agent}`;

/** The screen `caller` has open on `agent` that takes keys, if any. */
function typingScreenOf(caller: Caller, agent: string): Screen | undefined {
    for (const s of open.get(keyOf(consumerIdOf(caller) ?? "", agent)) ?? []) if (s.typing) return s;
    return undefined;
}

const idOf = (sub: Subscription) => sub.parts[1]!;

defineSubject({
    pattern: "agent.*.screen",
    replay: false,
    doc: {
        value: "`{ source }`: where the screen comes from, `host`, `tmux` or `node`; null when it cannot be followed (an `unavailable` event says why)",
        event: "`snapshot` / `output` (the session host: base64 bytes to write to a terminal, a snapshot after a reset), `size` (the host's size), `frame` (tmux or a node: the whole screen as text, with `cursor` and `geometry`), `error` (passing), `unavailable` (nothing more comes)",
    },
    access: (caller) => (caller.kind === "human" ? null : new Refusal(403, "an agent's screen is a human's view", ERROR_CODES.MODERATOR_ONLY)),
    setup: (sub) => {
        const agent = idOf(sub);
        const typing = sub.opts.typing === true;
        const size = sub.opts.size as Size | undefined;
        // Events go out once the subscription is registered: after the answer.
        const queued: unknown[] = [];
        let live = false;
        const emit = (e: unknown) => {
            if (live) sendTo(sub, e);
            else queued.push(e);
        };
        const screen = openScreen(agent, { typing, size }, emit);
        setImmediate(() => {
            live = true;
            for (const e of queued.splice(0)) sendTo(sub, e);
        });
        if (!screen) return;
        const key = keyOf(consumerIdOf(sub.caller) ?? "", agent);
        if (!open.has(key)) open.set(key, new Set());
        open.get(key)!.add(screen);
        sub.state.release = () => {
            screen.close();
            open.get(key)?.delete(screen);
            if (open.get(key)?.size === 0) open.delete(key);
        };
    },
    value: (sub) => {
        const where = screenSourceOf(idOf(sub));
        return typeof where === "string" ? { source: where } : null;
    },
    release: (sub) => (sub.state.release as (() => void) | undefined)?.(),
});

/**
 * Type into an agent's session: the keys as typed or pasted (control keys and
 * escape sequences included). On the session host they go through the screen
 * this caller has open with `typing`, and the host's keystroke detection sees
 * them; in tmux or on a node, straight to the pane.
 */
defineMethod({
    name: "agent.pane_keys",
    ...HUMAN,
    params: z.object({ agent: z.string().min(1), keys: z.string() }),
    run: async (caller, p) => {
        if (p.keys.length === 0) return { sent: 0 };
        if (Buffer.byteLength(p.keys, "utf8") > MAX_KEYS_BYTES) throw new Refusal(413, `keys over ${MAX_KEYS_BYTES} bytes`);
        const screen = typingScreenOf(caller, p.agent);
        if (!screen && screenSourceOf(p.agent) === "host") {
            throw new Refusal(409, "a session on the host takes keys through agent.<id>.screen subscribed with typing", ERROR_CODES.CONFLICT);
        }
        try {
            if (screen) await screen.keys(p.keys);
            else await keysWithoutScreen(p.agent, p.keys);
        } catch (e) {
            throw new Refusal(502, (e as Error).message, ERROR_CODES.BAD_GATEWAY);
        }
        return { sent: Buffer.byteLength(p.keys, "utf8") };
    },
});

/**
 * The size a typing viewer would like, for a session on the host: applied
 * while this viewer owns the size (it typed last), as with tmux's `latest`.
 * Nothing for a tmux or node pane, whose size is its terminal's.
 */
defineMethod({
    name: "agent.pane_resize",
    ...HUMAN,
    params: z.object({ agent: z.string().min(1), rows: z.number().int().min(1).max(1000), cols: z.number().int().min(1).max(1000) }),
    run: (caller, p) => {
        const screen = typingScreenOf(caller, p.agent);
        if (!screen) return { applied: false };
        screen.resize({ rows: p.rows, cols: p.cols });
        return { applied: screen.source === "host" };
    },
});
