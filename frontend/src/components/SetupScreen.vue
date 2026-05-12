<script setup lang="ts">
/**
 * First-time setup screen (#B.94). Reached either via the install-token
 * URL printed by `aiball auth init` (e.g. /setup?t=aiball-...) or by
 * navigating manually when the daemon reports `install_available`.
 *
 * Submits {token, consumer_id, password, display_name} → /api/auth/setup
 * which mints an auth token in return. Persists the token via
 * `setAuthToken` and reloads into the main app.
 */
import { ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import { api, setAuthToken } from "../lib/api";

const props = defineProps<{
    initialToken?: string | null;
}>();

const emit = defineEmits<{
    (e: "done"): void;
}>();

const installToken = ref(props.initialToken ?? "");
const consumerId = ref("");
const displayName = ref("");
const pw1 = ref("");
const pw2 = ref("");
const submitting = ref(false);
const error = ref<string | null>(null);

async function submit() {
    error.value = null;
    if (!installToken.value.trim()) {
        error.value = "Install token required (run `aiball auth init` in a terminal)";
        return;
    }
    if (!consumerId.value.trim()) {
        error.value = "Login required";
        return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(consumerId.value.trim())) {
        error.value = "Login must contain only letters, digits, dots, dashes, underscores";
        return;
    }
    if (pw1.value.length < 6) {
        error.value = "Password must be at least 6 characters";
        return;
    }
    if (pw1.value !== pw2.value) {
        error.value = "Passwords don't match";
        return;
    }
    submitting.value = true;
    try {
        const r = await api.authSetup({
            token: installToken.value.trim(),
            consumer_id: consumerId.value.trim(),
            password: pw1.value,
            display_name: displayName.value.trim() || null,
        });
        setAuthToken(r.token);
        // Also pin the picker's identity so the UI immediately shows
        // the right consumer in the header.
        localStorage.setItem("aiball.human_id", r.consumer_id);
        emit("done");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <div class="auth-screen">
        <div class="auth-card">
            <h1 class="auth-card__title">Set up aiball</h1>
            <p class="auth-card__subtitle">
                First-time setup. Pick a login and password — they'll be the credentials you use to access this aiball instance.
            </p>

            <div class="auth-field">
                <label for="token">Install token</label>
                <InputText
                    id="token"
                    v-model="installToken"
                    placeholder="aiball-..."
                    autocomplete="off"
                    spellcheck="false"
                />
                <p class="auth-hint">
                    Printed by <code>aiball auth init</code> in the terminal.
                </p>
            </div>

            <div class="auth-field">
                <label for="cid">Login</label>
                <InputText
                    id="cid"
                    v-model="consumerId"
                    placeholder="david"
                    autocomplete="username"
                />
                <p class="auth-hint">
                    Used both as the consumer_id (visible in tickets, pings, the MCP <code>by_agent</code>) and as your login here.
                </p>
            </div>

            <div class="auth-field">
                <label for="display">Display name</label>
                <InputText
                    id="display"
                    v-model="displayName"
                    placeholder="David (optional)"
                />
            </div>

            <div class="auth-field">
                <label for="pw1">Password</label>
                <Password id="pw1" v-model="pw1" :feedback="false" toggle-mask />
            </div>
            <div class="auth-field">
                <label for="pw2">Confirm password</label>
                <Password id="pw2" v-model="pw2" :feedback="false" toggle-mask />
            </div>

            <div v-if="error" class="auth-error">{{ error }}</div>

            <Button
                label="Create account"
                icon="pi pi-check"
                severity="success"
                :loading="submitting"
                @click="submit"
            />

            <p class="auth-footer">
                Already set up?
                <a href="/login">Log in instead</a>.
            </p>
        </div>
    </div>
</template>

<style>
.auth-screen {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--p-surface-50);
    padding: 1rem;
}
.aiball-dark .auth-screen {
    background: var(--p-surface-950);
}
.auth-card {
    width: 100%;
    max-width: 28rem;
    padding: 1.8rem 2rem;
    background: var(--p-content-background);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
}
.auth-card__title {
    margin: 0;
    font-size: 1.4rem;
}
.auth-card__subtitle {
    margin: 0;
    color: var(--p-text-muted-color);
    font-size: 0.9rem;
    line-height: 1.45;
}
.auth-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
}
.auth-field label {
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.auth-field :deep(.p-inputtext),
.auth-field :deep(.p-password),
.auth-field :deep(.p-password-input) {
    width: 100%;
}
.auth-hint {
    margin: 0;
    color: var(--p-text-muted-color);
    font-size: 0.78rem;
    line-height: 1.4;
}
.auth-hint code,
.auth-card__subtitle code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.78rem;
    padding: 0.05rem 0.3rem;
    background: var(--p-surface-100);
    border-radius: 0.2rem;
}
.aiball-dark .auth-hint code,
.aiball-dark .auth-card__subtitle code {
    background: var(--p-surface-800);
}
.auth-error {
    padding: 0.5rem 0.7rem;
    background: var(--p-red-50);
    color: var(--p-red-700);
    border: 1px solid var(--p-red-200);
    border-radius: 0.4rem;
    font-size: 0.85rem;
}
.aiball-dark .auth-error {
    background: var(--p-red-900);
    color: var(--p-red-200);
    border-color: var(--p-red-700);
}
.auth-footer {
    margin: 0;
    text-align: center;
    color: var(--p-text-muted-color);
    font-size: 0.85rem;
}
.auth-footer a {
    color: var(--p-primary-color);
}
</style>
