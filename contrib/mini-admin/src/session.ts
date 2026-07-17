import { computed, ref } from "vue";

// STEP 3 — auth.
//
// Modelled on how aiball actually works: rights live on the SERVER. `bearerAuth`
// resolves a consumer_id + token_kind per request and the route decides; the
// frontend carries no permission model at all. So a client can only learn what
// it may do by trying and being refused.
//
// This demo keeps that shape (the store refuses), and then has to work around
// it: a UI that only discovers rights by failing cannot hide a button it should
// never have offered. Hence this client-side mirror of the server's rule — the
// duplication is the finding, not an accident.

export type Role = "viewer" | "editor";

export const role = ref<Role>("editor");

export const canEdit = computed<boolean>(() => role.value === "editor");

/** Thrown by the store when the role is not allowed. Mirrors an HTTP 403. */
export class ForbiddenError extends Error {
    constructor(action: string) {
        super(`forbidden: a ${role.value} may not ${action}`);
        this.name = "ForbiddenError";
    }
}
