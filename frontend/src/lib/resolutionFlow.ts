/**
 * Resolution / decision flow composable for a single thread view
 * (#B.196 Layer 3 extract from ThreadView). Owns the composer body,
 * the busy flag, every accept / reject / close / reopen verb, the
 * four SplitButton/Menu models that surface them, and the two
 * derived computeds (activeDecision, pendingResolution) that decide
 * which branch the dock and toolbar render.
 *
 * Two reasons the whole flow lives together: every handler shares
 * the same composer body (it embarks any typed text as a comment
 * before the action), and every handler ends the same way (flip
 * busy off, broadcast a refresh, swallow the error onto the parent
 * sink). Splitting per-verb would duplicate that scaffolding.
 *
 * The composable returns 20 things — the parent destructures and
 * passes them down to ThreadActionsDock / ThreadToolbar.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { api, type Message, type ThreadView as ThreadViewData } from "./api";
import { findActiveDecision, type CommentDecision } from "./decisions";

interface UseResolutionFlowArgs {
    data: Ref<ThreadViewData | null>;
    error: Ref<string | null>;
    broadcastRefresh: (ticketId: number) => void;
    /** #902 david : assigner un agent en acceptant un plan/résolution doit
     *  passer le composer's assignee dropdown. Si défini, le handler
     *  acceptResolution/acceptWontfix/acceptEscalation appelle
     *  api.assignTicket après le accept (best-effort, comme ThreadView.decide
     *  pour les modération approvals). Le ref est mute par les handlers
     *  pour clear le dropdown au succès. */
    composerAssignee?: Ref<string>;
}

type PostKind =
    | "comment_added"
    | "ticket_closed"
    | "ticket_resolved"
    | "ticket_blocked"
    | "ticket_reopened";

interface MenuItem {
    label: string;
    icon: string;
    command: () => void;
}

export function useResolutionFlow({ data, error, broadcastRefresh, composerAssignee }: UseResolutionFlowArgs) {
    /** #902 — partagé par tous les handlers accept : apply le composer
     *  assignee si défini après le accept réussi (mirror du pattern
     *  ThreadView.decide pour la modération). Best-effort : un échec ne
     *  rollback pas le accept. */
    async function applyComposerAssignee(tid: number): Promise<void> {
        const next = composerAssignee?.value.trim();
        if (!next) return;
        try {
            await api.assignTicket(tid, next);
        } catch (e) {
            console.warn("[resolutionFlow] failed to assign on accept:", e);
        }
        if (composerAssignee) composerAssignee.value = "";
    }
    // Body of the in-thread composer, exposed here so the resolution-
    // decision buttons can piggy-back on whatever the user has typed
    // (e.g. closing the ticket while explaining what was done in the
    // textarea).
    const composerBody = ref("");
    const resolutionBusy = ref(false);

    // Latest pending resolution proposal — used to surface explicit
    // accept / not-resolved controls near the composer instead of
    // inside the comment card itself (per #C104). Once the ticket is
    // closed the proposal is moot, so we never surface a decision UI
    // in that state.
    const pendingResolution: ComputedRef<Message | null> = computed(() => {
        if (!data.value || data.value.ticket.closed) return null;
        // #B.129 follow-up: when a newer activeDecision exists on a
        // comment, the legacy ticket_resolved pending row is stale and
        // its accept controls would double-post (the legacy accept-as-
        // plan path posts a "(accepted as plan)" marker comment, while
        // the new decision-on-comment path correctly just flips meta).
        // Suppress the legacy controls in that case — the user should
        // only see one accept/reject pair under the composer.
        const pending = data.value.comments
            .filter((m) => m.kind === "ticket_resolved" && m.status === "pending")
            .sort((a, b) => b.id - a.id);
        const legacyTop = pending[0] ?? null;
        if (!legacyTop) return null;
        const newer = findActiveDecision(data.value.ticket, data.value.comments);
        if (newer && newer.message.id > legacyTop.id) return null;
        return legacyTop;
    });

    // #B.129 phase 3: the active decision = the most recent
    // comment_added in this thread carrying
    // `meta.decision.status === "pending"`. Drives the accept/reject
    // pair under the composer. Replaces the legacy pendingResolution
    // path for new posts (the legacy lookup above stays only so
    // historical `ticket_resolved` rows still get the right UI).
    const activeDecision: ComputedRef<{ message: Message; decision: CommentDecision } | null> =
        computed(() => {
            if (!data.value || data.value.ticket.closed) return null;
            // #803 — pass ticket so a decision attached on ticket_created
            // (via ticket_new({then:"plan"})) surfaces in the dock.
            return findActiveDecision(data.value.ticket, data.value.comments);
        });

    const hasBody = computed(() => composerBody.value.trim().length > 0);

    async function postBodyAs(kind: PostKind, decisionKind?: "plan" | "resolution") {
        if (!data.value) return;
        const t = data.value.ticket;
        const trimmed = composerBody.value.trim();
        if (!trimmed && kind === "comment_added" && !decisionKind) return; // no-op
        const byAgent = localStorage.getItem("aiball.human_id") || "human";
        // Goes through api.postMessage → req() so the bearer token + the
        // X-Aiball-Consumer header are attached. Hitting fetch() directly
        // bypassed both and returned 401 once auth became mandatory.
        await api.postMessage({
            project: t.project,
            kind,
            ticket_id: t.id,
            parent_id: t.id,
            body: trimmed || undefined,
            by_agent: byAgent,
            decision_kind: decisionKind,
        });
    }

    async function acceptResolution(asKind?: "plan" | "resolution") {
        const msg = pendingResolution.value;
        if (!msg || !data.value) return;
        const tid = data.value.ticket.id;
        const effectiveKind = asKind ?? "resolution";
        resolutionBusy.value = true;
        try {
            // #B.129 follow-up: the reporter can reclassify a legacy
            // ticket_resolved row as "really a plan" — same mechanic as
            // the new decision-on-comment flow. We approve the message
            // either way; the close is suppressed when accepting as plan.
            // When reclassifying, post a marker comment so the audit
            // trail shows the reclassification.
            if (effectiveKind === "plan") {
                await api.approve(msg.id);
                if (composerBody.value.trim()) {
                    // The typed body becomes a plan-accepted comment so it
                    // carries the chip (per #B.129 / #C.ffvfgm david: chip
                    // must surface visually on the audit comment, not just
                    // in the absent meta of the legacy ticket_resolved row).
                    await postBodyAs("comment_added", "plan");
                } else {
                    // Empty composer → drop the canned marker AND stamp
                    // its meta.decision so CommentNode renders the
                    // "✓ accepted plan by david" chip. Without it the
                    // marker shows as bare text, no visual feedback.
                    const t = data.value.ticket;
                    const byAgent = localStorage.getItem("aiball.human_id") || "human";
                    const posted = await api.postMessage({
                        project: t.project,
                        kind: "comment_added",
                        ticket_id: t.id,
                        parent_id: t.id,
                        body: `(accepted as plan — ticket stays open)`,
                        by_agent: byAgent,
                        decision_kind: "plan",
                    });
                    // Flip it to accepted immediately so the chip reads
                    // "✓ accepted plan by <byAgent>" rather than "pending".
                    if (posted?.id) {
                        try {
                            await api.decide(posted.id, "accepted");
                        } catch { /* race-tolerant — chip will catch up on next refresh */ }
                    }
                }
            } else {
                // #618 — single atomic call : the server approves the
                // pending resolution + inserts the ticket_closed event
                // in one request, with both broadcasts arriving
                // back-to-back. Replaces the previous 2-step
                // `approve` + `postBodyAs("ticket_closed")` whose
                // network gap caused the dock-flicker fixed in #617.
                // The typed body (if any) rides along on the close
                // event so the reporter's "yes, this is done" gets a
                // single decorated card.
                await api.acceptAndClose(msg.id, composerBody.value.trim() || undefined);
            }
            composerBody.value = "";
            // #902 — apply le composer assignee si présent (mirror du
            // pattern moderation decide). Couvre accept-plan et accept-
            // resolution dans la même branche.
            await applyComposerAssignee(tid);
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function rejectResolution() {
        const msg = pendingResolution.value;
        if (!msg || !data.value) return;
        const tid = data.value.ticket.id;
        resolutionBusy.value = true;
        try {
            if (composerBody.value.trim()) {
                await postBodyAs("comment_added");
            }
            await api.reject(msg.id);
            composerBody.value = "";
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function commentAndMarkResolved() {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        resolutionBusy.value = true;
        try {
            // #B.129 phase 2: a resolution proposal is now a comment with
            // `meta.decision={kind:"resolution",status:"pending"}` rather
            // than a dedicated ticket_resolved row.
            await postBodyAs("comment_added", "resolution");
            composerBody.value = "";
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function commentAndProposePlan() {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        resolutionBusy.value = true;
        try {
            await postBodyAs("comment_added", "plan");
            composerBody.value = "";
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    // #B.129 phase 3: accept / reject the active decision on a comment.
    // For a resolution decision, accepting also closes the ticket (same
    // composite action as the legacy "accept resolution and close"). For
    // a plan decision, accepting just flips the meta — ticket stays open.
    //
    // `asKind` (#B.129 follow-up): the reporter can reclassify the
    // decision at accept-time — e.g. "this was tagged as a resolution
    // but it's really just a plan, accept it as a plan". When `asKind`
    // is passed AND differs from the original kind, the close side-
    // effect of resolution-accept is suppressed (we want plan ergonomics).
    async function acceptActiveDecision(asKind?: "plan" | "resolution" | "wontfix" | "escalation") {
        const active = activeDecision.value;
        if (!active || !data.value) return;
        const tid = data.value.ticket.id;
        const effectiveKind = asKind ?? active.decision.kind;
        resolutionBusy.value = true;
        try {
            // Post the typed body EXACTLY ONCE. For resolution-accept
            // the body rides along on the ticket_closed event so the
            // explanation + close show as a single decorated card; for
            // plan-accept (no close follows), the body lands as a plain
            // comment. David #B.140: previously both branches fired,
            // duplicating the body (one comment_added + one ticket_closed
            // both carrying the same text). One source of truth per accept.
            // #817 : wontfix-accept also auto-closes (handled server-side
            // by the /decide handler, see #802) so we suppress the body
            // here too (the post-decide refresh re-renders the comment).
            if (composerBody.value.trim() && effectiveKind !== "resolution" && effectiveKind !== "wontfix") {
                await postBodyAs("comment_added");
            }
            await api.decide(active.message.id, "accepted", asKind);
            if (effectiveKind === "resolution") {
                await postBodyAs("ticket_closed");
            }
            // wontfix : the server-side /decide handler auto-posts the
            // ticket_closed (per #802), no extra round-trip needed here.
            composerBody.value = "";
            // #902 — apply le composer assignee si présent. Couvre les 4
            // kinds accept (plan / resolution / wontfix / escalation).
            await applyComposerAssignee(tid);
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function reclassifyActiveDecision(newKind: "plan" | "resolution" | "wontfix" | "escalation") {
        const active = activeDecision.value;
        if (!active || !data.value) return;
        const tid = data.value.ticket.id;
        if (active.decision.kind === newKind) return;
        resolutionBusy.value = true;
        try {
            await api.reclassify(active.message.id, newKind);
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function rejectActiveDecision() {
        const active = activeDecision.value;
        if (!active || !data.value) return;
        const tid = data.value.ticket.id;
        resolutionBusy.value = true;
        try {
            if (composerBody.value.trim()) {
                await postBodyAs("comment_added");
            }
            await api.decide(active.message.id, "rejected");
            composerBody.value = "";
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function commentAndClose() {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        resolutionBusy.value = true;
        try {
            await postBodyAs("ticket_closed");
            composerBody.value = "";
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function commentAndReopen() {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        resolutionBusy.value = true;
        try {
            await postBodyAs("ticket_reopened");
            composerBody.value = "";
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    async function commentAndUndoReject() {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        resolutionBusy.value = true;
        try {
            // Re-decide the rejected ticket as approved. If a body is typed, it
            // is posted as a regular comment first so the trail of why we
            // rolled back the rejection is preserved on the thread.
            if (composerBody.value.trim()) {
                await postBodyAs("comment_added");
            }
            await api.approve(tid);
            composerBody.value = "";
            broadcastRefresh(tid);
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            resolutionBusy.value = false;
        }
    }

    // Menu items for the legacy pendingResolution path — same
    // reclassify idea as the new-flow acceptMenu but reached when the
    // active "resolution" is a historical ticket_resolved row (not a
    // comment+decision). Arrow notation matches the new-flow labels
    // (#B.139).
    const legacyAcceptMenu: ComputedRef<MenuItem[]> = computed(() => [
        {
            label: "accept resolution → close the ticket",
            icon: "pi pi-check-circle",
            command: () => { void acceptResolution(); },
        },
        {
            label: "accept as plan → keep the ticket open",
            icon: "pi pi-compass",
            command: () => { void acceptResolution("plan"); },
        },
    ]);

    // Menu items for the reporter's accept SplitButton (#B.129
    // follow-up). Surfaces two related-but-distinct paths:
    //   - "accept as <other-kind>" flips kind + status in one shot
    //   - "just reclassify to <other-kind>" flips kind only, decision
    //     stays pending (per david: "je dois pouvoir requalifier en
    //     voici mon plan").
    // #B.139: SplitButton had a hidden "default" action on the main
    // button + alternates in the dropdown — david found the wording
    // unclear (clicking a dropdown item fires that action directly, but
    // the main label stays generic so the relationship is hard to read).
    // SplitButton main click = the kind's "natural" accept. Dropdown
    // lists ALL options including the main action again (#B.139
    // follow-up). User has two paths to the default: quick click OR
    // dropdown pick. Alternates carry the EFFECT in the label via the
    // arrow → notation.
    const acceptMenu: ComputedRef<MenuItem[]> = computed(() => {
        const active = activeDecision.value;
        if (!active) return [];
        const items: MenuItem[] = [];
        // #817 736u8h david : `reclassify as X` items live in the REJECT
        // dropdown only — accept dropdown stays focused on accept paths
        // (the default kind's accept + the cross-kind accept-as variants).
        if (active.decision.kind === "resolution") {
            items.push({
                label: "accept resolution → close the ticket",
                icon: "pi pi-check-circle",
                command: () => { void acceptActiveDecision(); },
            });
            items.push({
                label: "accept as plan → keep the ticket open",
                icon: "pi pi-compass",
                command: () => { void acceptActiveDecision("plan"); },
            });
            items.push({
                label: "accept as wontfix → close without resolution",
                icon: "pi pi-ban",
                command: () => { void acceptActiveDecision("wontfix"); },
            });
        } else if (active.decision.kind === "plan") {
            items.push({
                label: "accept plan → keep the ticket open",
                icon: "pi pi-check-circle",
                command: () => { void acceptActiveDecision(); },
            });
            items.push({
                label: "accept as resolution → close the ticket",
                icon: "pi pi-verified",
                command: () => { void acceptActiveDecision("resolution"); },
            });
            items.push({
                label: "accept as wontfix → close without resolution",
                icon: "pi pi-ban",
                command: () => { void acceptActiveDecision("wontfix"); },
            });
        } else if (active.decision.kind === "wontfix") {
            items.push({
                label: "accept wontfix → close without resolution",
                icon: "pi pi-check-circle",
                command: () => { void acceptActiveDecision(); },
            });
            items.push({
                label: "accept as resolution → close (with resolved flip)",
                icon: "pi pi-verified",
                command: () => { void acceptActiveDecision("resolution"); },
            });
            items.push({
                label: "accept as plan → keep the ticket open",
                icon: "pi pi-compass",
                command: () => { void acceptActiveDecision("plan"); },
            });
        } else if (active.decision.kind === "escalation") {
            // #737 — accepting an escalation = "I (the human) did the
            // action you needed". Ungates the ticket so the agent can
            // continue ; explicitly NOT a close — the ticket isn't
            // "done", it's just unblocked. Cross-kind accepts are
            // listed too in case the reporter wants to fold the
            // ack into a final state (close-as-resolved, close-as-
            // wontfix, or downgrade to plan if the ack was misframed).
            items.push({
                label: "accept escalation → action done, ticket continues",
                icon: "pi pi-check-circle",
                command: () => { void acceptActiveDecision(); },
            });
            items.push({
                label: "accept as resolution → close the ticket",
                icon: "pi pi-verified",
                command: () => { void acceptActiveDecision("resolution"); },
            });
            items.push({
                label: "accept as plan → keep the ticket open",
                icon: "pi pi-compass",
                command: () => { void acceptActiveDecision("plan"); },
            });
            items.push({
                label: "accept as wontfix → close without resolution",
                icon: "pi pi-ban",
                command: () => { void acceptActiveDecision("wontfix"); },
            });
        }
        return items;
    });

    // #B.167: reject as a split button — default action rejects the
    // current decision kind; menu items offer requalification
    // (reclassify to the other kind, leaving status pending).
    const rejectMenu: ComputedRef<MenuItem[]> = computed(() => {
        const active = activeDecision.value;
        if (!active) return [];
        // #817 : the kind set is now {resolution, plan, wontfix}. #737
        // adds escalation. List every OTHER kind as a reclassify option
        // (= "actually this is not a $current, it's a $other, leave it
        // pending").
        const allKinds: Array<"plan" | "resolution" | "wontfix" | "escalation"> = ["resolution", "plan", "wontfix", "escalation"];
        const others = allKinds.filter((k) => k !== active.decision.kind);
        const items: MenuItem[] = [
            {
                label: `reject ${active.decision.kind}`,
                icon: "pi pi-times",
                command: () => { void rejectActiveDecision(); },
            },
        ];
        for (const other of others) {
            items.push({
                label: `reclassify as ${other} → still pending`,
                icon: "pi pi-pencil",
                command: () => { void reclassifyActiveDecision(other); },
            });
        }
        return items;
    });

    // #B.129 — author decision splitbutton: primary action = mark
    // resolved (the most common case once work is done), dropdown
    // reveals less-frequent options (propose plan, …). Keeps the
    // visual surface tight — one button visible, the secondary kinds
    // discoverable via chevron.
    const decisionMenu: ComputedRef<MenuItem[]> = computed(() => [
        {
            label: hasBody.value ? "comment and propose plan" : "propose plan",
            icon: "pi pi-compass",
            command: () => { void commentAndProposePlan(); },
        },
    ]);

    return {
        composerBody,
        resolutionBusy,
        hasBody,
        postBodyAs,
        activeDecision,
        pendingResolution,
        acceptResolution,
        rejectResolution,
        commentAndMarkResolved,
        commentAndProposePlan,
        acceptActiveDecision,
        rejectActiveDecision,
        reclassifyActiveDecision,
        commentAndClose,
        commentAndReopen,
        commentAndUndoReject,
        acceptMenu,
        rejectMenu,
        legacyAcceptMenu,
        decisionMenu,
    };
}
