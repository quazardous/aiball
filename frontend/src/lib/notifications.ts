/**
 * Arrival notifications + OS push for the App.vue toaster (extracted
 * from App.vue in #B.213 phase A.2 on 2026-05-19).
 *
 * Two layers:
 *   - **OS-level Notification** — lazy permission ask, mute toggle
 *     persisted in localStorage, suppression when the page has focus.
 *   - **In-app toast** rendered via PrimeVue's `useToast()`. Pending
 *     messages get a 250 ms hold-and-debounce so auto-approve projects
 *     don't fire two toasts (pending → approved) for the same message.
 *
 * Exposed composable: `useNotifications({ project })`. `project` is
 * the currently-active project filter — arrivals outside that scope
 * are silently dropped (App.vue's previous behaviour). Returned
 * surface mirrors what App.vue used inline:
 *   - `notifMuted` / `notifAllowed` (refs)
 *   - `toggleMute()`
 *   - `ensureNotifPermission()`
 *   - `notifyArrival(m)` — single entry point for the `message.arrived`
 *     and `message.decided` bus subscribers.
 */
import { ref, type Ref } from "vue";
import { useToast } from "primevue/usetoast";
import type { Message } from "./api";

function shortKindLabel(m: Message): string {
    switch (m.kind) {
        case "ticket_created":
            return "ticket";
        case "comment_added":
            return "comment";
        case "ticket_closed":
            return "ticket close";
    }
    return m.kind;
}

export function useNotifications(opts: { project: Ref<string | null> }) {
    const toast = useToast();
    const { project } = opts;

    // OS notifications: lazily ask permission on first interaction so we don't
    // spam the user with a permission popup at boot.
    const notifAllowed = ref(
        typeof Notification !== "undefined" && Notification.permission === "granted",
    );
    const notifMuted = ref(localStorage.getItem("aiball.notifMuted") === "1");

    function toggleMute() {
        notifMuted.value = !notifMuted.value;
        localStorage.setItem("aiball.notifMuted", notifMuted.value ? "1" : "0");
    }

    async function ensureNotifPermission(): Promise<boolean> {
        if (typeof Notification === "undefined") return false;
        if (Notification.permission === "granted") {
            notifAllowed.value = true;
            return true;
        }
        if (Notification.permission === "denied") return false;
        const r = await Notification.requestPermission();
        notifAllowed.value = r === "granted";
        return notifAllowed.value;
    }

    function fireOsNotif(title: string, body: string) {
        if (notifMuted.value) return;
        if (typeof Notification === "undefined") return;
        if (Notification.permission !== "granted") return;
        if (document.hasFocus()) return; // page already visible, toast is enough
        try {
            new Notification(title, { body, tag: "aiball" });
        } catch {
            /* ignore */
        }
    }

    // #B.194: auto-approve projects emit message_created (pending) then
    // message_decided (approved) in quick succession → two toasts per
    // message. Hold the pending toast 250ms; if a decision lands first,
    // cancel the pending and only show the decision.
    const pendingArrivalTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const PENDING_TOAST_HOLD_MS = 250;

    // #B.257: defensive dedup at render time. Whatever the source of a
    // duplicate `message_created`/`message_decided` arrival — multiple
    // WS sockets (tailscale + LAN, visibility-reconnect race), server
    // re-broadcast on tag/edit, double-bus emission — we never want
    // two toasts for the SAME (message.id, status). Track recent
    // renders with a short window so a real status transition
    // (pending → approved) still gets through (the pending hold above
    // already collapses that case, but if it did slip past, the new
    // status gives a fresh key).
    const renderedRecently = new Map<string, number>();
    const RENDER_DEDUP_MS = 4000;

    function renderArrivalToast(m: Message) {
        const dedupKey = `${m.id}:${m.status}`;
        const now = Date.now();
        const last = renderedRecently.get(dedupKey);
        if (last !== undefined && now - last < RENDER_DEDUP_MS) return;
        renderedRecently.set(dedupKey, now);
        // Lazy GC: prune anything older than the window so the map
        // doesn't grow unbounded on a long-lived session.
        for (const [k, ts] of renderedRecently) {
            if (now - ts >= RENDER_DEDUP_MS) renderedRecently.delete(k);
        }

        const who = m.by_agent ?? "unknown";
        const k = shortKindLabel(m);
        const summary = m.title ?? (m.body ? m.body.slice(0, 80) : `new ${k}`);
        const ref =
            m.kind === "ticket_created"
                ? `#B.${m.id}`
                : `#C.${m.hashid ?? m.id}`;
        const detail = `${who} · ${ref} · ${m.project}`;

        toast.add({
            severity: m.status === "pending" ? "warn" : "info",
            summary: `${k}${m.status === "pending" ? " pending review" : ""}: ${summary}`,
            detail,
            life: 8000,
        });
        fireOsNotif(`aiball — ${k}`, `${summary}\n${detail}`);
    }

    function notifyArrival(m: Message) {
        const inScope = !project.value || project.value === m.project;
        if (!inScope) return;

        if (m.status !== "pending") {
            const t = pendingArrivalTimers.get(m.id);
            if (t) {
                clearTimeout(t);
                pendingArrivalTimers.delete(m.id);
            }
            renderArrivalToast(m);
            return;
        }

        if (pendingArrivalTimers.has(m.id)) return;
        const t = setTimeout(() => {
            pendingArrivalTimers.delete(m.id);
            renderArrivalToast(m);
        }, PENDING_TOAST_HOLD_MS);
        pendingArrivalTimers.set(m.id, t);
    }

    return {
        notifAllowed,
        notifMuted,
        toggleMute,
        ensureNotifPermission,
        notifyArrival,
    };
}
