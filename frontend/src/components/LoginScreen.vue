<script setup lang="ts">
/**
 * Login screen (#B.94). Reached on first load when there's no token in
 * localStorage, or after a 401. Submits {consumer_id, password} →
 * /api/auth/login and stores the returned token.
 */
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Password from "primevue/password";
import { api, setAuthToken } from "../lib/api";

const emit = defineEmits<{
    (e: "done"): void;
    (e: "need-setup"): void;
}>();

const consumerId = ref("");
const password = ref("");
const submitting = ref(false);
const error = ref<string | null>(null);

onMounted(async () => {
    try {
        const s = await api.authStatus();
        if (!s.ready) {
            // No humans yet — setup is the only meaningful entry.
            emit("need-setup");
        }
    } catch {
        /* keep showing the form, user can still try */
    }
});

async function submit() {
    error.value = null;
    if (!consumerId.value.trim()) {
        error.value = "Login required";
        return;
    }
    if (!password.value) {
        error.value = "Password required";
        return;
    }
    submitting.value = true;
    try {
        const r = await api.authLogin({
            consumer_id: consumerId.value.trim(),
            password: password.value,
        });
        setAuthToken(r.token);
        // See SetupScreen for why both keys are set.
        localStorage.setItem("aiball.me", r.consumer_id);
        localStorage.setItem("aiball.human_id", r.consumer_id);
        emit("done");
    } catch (e) {
        error.value = (e as Error).message.includes("401")
            ? "Invalid login or password"
            : (e as Error).message;
    } finally {
        submitting.value = false;
    }
}
</script>

<template>
    <div class="auth-screen">
        <div class="auth-card">
            <h1 class="auth-card__title">Log in to aiball</h1>
            <p class="auth-card__subtitle">
                Enter the login and password you set during setup.
            </p>

            <div class="auth-field">
                <label for="cid">Login</label>
                <InputText
                    id="cid"
                    v-model="consumerId"
                    autocomplete="username"
                    @keydown.enter.prevent="submit"
                />
            </div>

            <div class="auth-field">
                <label for="pw">Password</label>
                <Password
                    id="pw"
                    v-model="password"
                    :feedback="false"
                    toggle-mask
                    @keydown.enter.prevent="submit"
                />
            </div>

            <div v-if="error" class="auth-error">{{ error }}</div>

            <Button
                label="Log in"
                icon="pi pi-sign-in"
                severity="success"
                :loading="submitting"
                @click="submit"
            />

            <p class="auth-footer">
                Forgot your password? Run <code>aiball auth reinit</code> in the terminal to get a setup URL.
            </p>
        </div>
    </div>
</template>

<style>
/* Styles are shared with SetupScreen.vue (loaded together via the
   Vue scope-cascade). No duplication needed. */
</style>
