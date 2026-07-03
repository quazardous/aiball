<script setup lang="ts">
/**
 * First-time setup screen (#B.94). Reached either via the install-token
 * URL printed by `aiball auth init` (e.g. /setup?t=aiball-...) or by
 * navigating manually when the daemon reports `install_available`.
 *
 * Gated: on mount we call /api/auth/status. The form is only revealed
 * when `install_available === true` — i.e. someone just ran `aiball
 * auth init` (first boot) or `aiball auth reinit` (password reset).
 * Otherwise we render a "not allowed" panel pointing at /login.
 */
import { onMounted, ref } from "vue";
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

// Gate: "checking" → call status; "allowed" → show form; "denied" →
// show "no install token" screen.
const gate = ref<"checking" | "allowed" | "denied">("checking");
const alreadyReady = ref(false);

onMounted(async () => {
    try {
        const s = await api.authStatus();
        alreadyReady.value = s.ready;
        gate.value = s.install_available ? "allowed" : "denied";
    } catch {
        // Daemon unreachable — leave the form available so the user
        // can still try (and see a clear backend error on submit).
        gate.value = "allowed";
    }
});

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
        // Pin both the auth identity (`aiball.me` — never changed by the
        // peek picker) and the active acting identity (`aiball.human_id`,
        // used by IdentityPicker as the "as X" override). They start
        // equal; the picker can later reassign human_id without losing
        // the reset target.
        localStorage.setItem("aiball.me", r.consumer_id);
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
        <div v-if="gate === 'checking'" class="auth-card">
            <p class="auth-card__subtitle">Checking install state…</p>
        </div>

        <div v-else-if="gate === 'denied'" class="auth-card">
            <h1 class="auth-card__title">Setup not available</h1>
            <p class="auth-card__subtitle">
                <template v-if="alreadyReady">
                    This aiball instance is already set up. To re-run setup
                    (e.g. password reset), run <code>aiball auth reinit</code>
                    in a terminal — it mints a fresh install token and prints
                    the URL.
                </template>
                <template v-else>
                    No install token has been minted yet. Run
                    <code>aiball auth init</code> in a terminal first.
                </template>
            </p>
            <p class="auth-footer">
                <a href="/login">Go to login</a>
            </p>
        </div>

        <div v-else class="auth-card">
            <h1 class="auth-card__title">Set up aiball</h1>
            <p class="auth-card__subtitle">
                <template v-if="alreadyReady">
                    Re-running setup with a fresh install token. Pick a login
                    (existing ones get their password updated, new ones get
                    created).
                </template>
                <template v-else>
                    First-time setup. Pick a login and password — they'll be
                    the credentials you use to access this aiball instance.
                </template>
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
                    placeholder="optional"
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

<style src="./auth-screens.css"></style>
