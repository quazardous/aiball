<script setup lang="ts">
/**
 * #2276 — the Signals tab of a project: the signals external systems sent it,
 * and the signal keys — who holds each one, and why.
 *
 * Keys are not tied to a project, so every key is listed, each with the
 * signals it sent here. A key is addressed by its non-secret `key_id`; its
 * token is shown once, right after minting, and the page forgets it on
 * "Done".
 */
import { computed, nextTick, onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { useConfirm } from "primevue/useconfirm";
import { useToast } from "primevue/usetoast";
import { api, type ProjectSignal, type SignalKeyView } from "../lib/api";
import { useLoader } from "../lib/loader";
import DataList, { type DataListColumn } from "./ui/DataList.vue";
import SectionHeader from "./ui/SectionHeader.vue";
import StatusPill from "./ui/StatusPill.vue";

const props = defineProps<{ project: string }>();

const toast = useToast();
const confirm = useConfirm();

const signals = ref<ProjectSignal[]>([]);
const keys = ref<SignalKeyView[]>([]);

const { loading, error, load } = useLoader(async () => {
    const [s, k] = await Promise.all([
        api.listProjectSignals(props.project),
        api.listSignalKeys(props.project),
    ]);
    signals.value = s.signals;
    keys.value = k;
});
onMounted(() => { void load(); });

function fmt(ts: string | null): string {
    if (!ts) return "—";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** The API error text is `METHOD path → status: {"error": "…"}`; keep the sentence. */
function reason(e: unknown): string {
    const msg = (e as Error).message ?? String(e);
    const body = msg.replace(/^[^:]*→ \d+: /, "");
    try {
        return (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
        return body;
    }
}

function targetOf(s: ProjectSignal): string {
    return s.target_consumer ?? `${s.target_project} · ${s.target_level}`;
}

const DELIVERY_PILL = { delivered: "up", pending: "stale", expired: "down" } as const;
const DELIVERY_TITLE = {
    delivered: "its loop injected it",
    pending: "waiting for its loop to be idle and awake",
    expired: "never injected before it expired",
} as const;

const signalColumns: DataListColumn[] = [
    { key: "created_at", label: "Received", sortable: true, defaultDir: "desc" },
    { key: "source", label: "Source", sortable: true, defaultDir: "asc" },
    { key: "target", label: "Aimed at", sortable: true, defaultDir: "asc" },
    { key: "title", label: "Signal" },
    { key: "deliveries", label: "Delivery" },
];

function signalSort(row: ProjectSignal, key: string): string | number {
    switch (key) {
        case "created_at": return Date.parse(row.created_at);
        case "source": return row.source.toLowerCase();
        case "target": return targetOf(row).toLowerCase();
        default: return "";
    }
}

const keyColumns: DataListColumn[] = [
    { key: "label", label: "Source", sortable: true, defaultDir: "asc" },
    { key: "note", label: "Given to, and why" },
    { key: "last_used_at", label: "Last used", sortable: true, defaultDir: "desc" },
    { key: "signals", label: "Signals here / all", sortable: true, defaultDir: "desc" },
    { key: "actions", label: "" },
];

function keySort(row: SignalKeyView, key: string): string | number {
    switch (key) {
        case "label": return row.label.toLowerCase();
        case "last_used_at": return row.last_used_at ? Date.parse(row.last_used_at) : 0;
        case "signals": return row.signals_to_project ?? 0;
        default: return "";
    }
}

// Editing a note, one key at a time.
const editingKey = ref<string | null>(null);
const editNote = ref("");
const savingNote = ref(false);
async function startEdit(k: SignalKeyView): Promise<void> {
    editingKey.value = k.key_id;
    editNote.value = k.note ?? "";
    // The field appears after the click, so an autofocus attribute would never
    // fire: focus it once it is rendered, or the first keystrokes go nowhere.
    await nextTick();
    document.querySelector<HTMLInputElement>(".project-signals__note-edit input")?.focus();
}
async function saveNote(k: SignalKeyView): Promise<void> {
    savingNote.value = true;
    try {
        const updated = await api.updateSignalKeyNote(k.key_id, editNote.value);
        keys.value = keys.value.map((x) => (x.key_id === k.key_id ? { ...x, note: updated.note } : x));
        editingKey.value = null;
    } catch (e) {
        toast.add({ severity: "error", summary: "Note not saved", detail: reason(e), life: 8000 });
    } finally {
        savingNote.value = false;
    }
}

// Minting. The token lives in `minted` until "Done", and nowhere else.
const newLabel = ref("");
const newNote = ref("");
const minting = ref(false);
const minted = ref<{ label: string; token: string } | null>(null);
const canMint = computed(() => !!newLabel.value.trim() && !!newNote.value.trim() && !minting.value);

async function mint(): Promise<void> {
    if (!canMint.value) return;
    minting.value = true;
    try {
        const r = await api.createSignalKey(newLabel.value.trim(), newNote.value.trim());
        minted.value = { label: r.key.label, token: r.token };
        newLabel.value = "";
        newNote.value = "";
        await load();
    } catch (e) {
        toast.add({ severity: "error", summary: "Key not minted", detail: reason(e), life: 8000 });
    } finally {
        minting.value = false;
    }
}

async function copyToken(): Promise<void> {
    if (!minted.value) return;
    try {
        await navigator.clipboard.writeText(minted.value.token);
        toast.add({ severity: "success", summary: "Key copied", life: 3000 });
    } catch {
        toast.add({ severity: "warn", summary: "Copy refused by the browser", detail: "Select the key and copy it by hand.", life: 6000 });
    }
}

function confirmRevoke(k: SignalKeyView): void {
    confirm.require({
        header: "Revoke this signal key?",
        message: `"${k.label}"${k.note ? ` (${k.note})` : ""} will no longer be able to post signals. The signals it already sent stay listed.`,
        icon: "pi pi-exclamation-triangle",
        acceptLabel: "Revoke",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void revoke(k); },
    });
}
async function revoke(k: SignalKeyView): Promise<void> {
    try {
        await api.revokeSignalKey(k.key_id);
        toast.add({ severity: "success", summary: `Key "${k.label}" revoked`, life: 5000 });
        await load();
    } catch (e) {
        toast.add({ severity: "error", summary: "Revocation failed", detail: reason(e), life: 8000 });
    }
}
</script>

<template>
    <div class="project-signals">
        <section class="aiball-section">
            <SectionHeader title="Received signals">
                Signals external systems sent to this project, or to one of its owners. A
                signal wakes its recipient's loop once it is idle, through the same gates as
                any other wake; it is <em>delivered</em> once the loop has injected it.
                <template #actions>
                    <Button icon="pi pi-refresh" text size="small" :loading="loading" title="Refresh" @click="load" />
                </template>
            </SectionHeader>
            <DataList
                table-class="project-signals__table"
                :columns="signalColumns"
                :rows="signals"
                :row-key="(s: ProjectSignal) => s.id"
                :get-sort-value="signalSort"
                default-sort-key="created_at"
                default-sort-dir="desc"
                :loading="loading && !signals.length"
                :error="error"
                :is-empty="!signals.length"
            >
                <template #empty>
                    <div class="aiball-empty">
                        <i class="pi pi-bolt" style="font-size: 1.6rem" />
                        <p>No signal has reached this project yet.</p>
                    </div>
                </template>
                <template #cell-created_at="{ row }">
                    <span :title="`expires ${fmt(row.expires_at)}`">{{ fmt(row.created_at) }}</span>
                </template>
                <template #cell-source="{ row }">
                    <code>{{ row.source }}</code>
                </template>
                <template #cell-target="{ row }">{{ targetOf(row) }}</template>
                <template #cell-title="{ row }">
                    <StatusPill v-if="row.severity === 'panic'" status="error" label="panic" title="posted with severity panic" />
                    <span :title="row.body ?? undefined">{{ row.title }}</span>
                    <span
                        v-if="row.repeat_count > 1"
                        class="project-signals__repeat"
                        :title="`refreshed ${row.repeat_count - 1} time(s), last ${fmt(row.updated_at)}`"
                    >×{{ row.repeat_count }}</span>
                </template>
                <template #cell-deliveries="{ row }">
                    <span v-if="!row.deliveries.length" class="project-signals__muted" title="no owner of the target worked on its level">nobody</span>
                    <span v-for="d in row.deliveries" :key="d.recipient" class="project-signals__delivery">
                        <StatusPill
                            :status="DELIVERY_PILL[d.state]"
                            :label="d.state"
                            :title="`${d.recipient}: ${DELIVERY_TITLE[d.state]}${d.acked_at ? ` (${fmt(d.acked_at)})` : ''}`"
                        />
                        {{ d.recipient }}
                    </span>
                </template>
            </DataList>
        </section>

        <section class="aiball-section">
            <SectionHeader title="Signal keys">
                A key lets one external system post signals; its label is the source shown
                above. Keys are not tied to a project, so every key is listed, with the
                signals it sent here.
            </SectionHeader>

            <div v-if="minted" class="project-signals__minted">
                <p>
                    <strong>Key for "{{ minted.label }}"</strong> — shown this once. Copy it now:
                    once you leave, it cannot be displayed again.
                </p>
                <code class="project-signals__token">{{ minted.token }}</code>
                <div class="project-signals__minted-actions">
                    <Button icon="pi pi-copy" label="Copy" size="small" @click="copyToken" />
                    <Button label="Done" size="small" severity="secondary" outlined @click="minted = null" />
                </div>
            </div>

            <DataList
                table-class="project-signals__table"
                :columns="keyColumns"
                :rows="keys"
                :row-key="(k: SignalKeyView) => k.key_id"
                :get-sort-value="keySort"
                default-sort-key="label"
                default-sort-dir="asc"
                :loading="loading && !keys.length"
                :error="error"
                :is-empty="!keys.length"
            >
                <template #empty>
                    <div class="aiball-empty">
                        <i class="pi pi-key" style="font-size: 1.6rem" />
                        <p>No signal key yet. Mint one below for each external system.</p>
                    </div>
                </template>
                <template #cell-label="{ row }">
                    <code>{{ row.label }}</code>
                    <code class="project-signals__id">{{ row.key_id }}</code>
                </template>
                <template #cell-note="{ row }">
                    <form v-if="editingKey === row.key_id" class="project-signals__note-edit" @submit.prevent="saveNote(row)">
                        <InputText v-model="editNote" size="small" class="w-full" aria-label="Note" />
                        <Button type="submit" icon="pi pi-check" size="small" text :loading="savingNote" :disabled="!editNote.trim()" title="Save" />
                        <Button icon="pi pi-times" size="small" text severity="secondary" title="Cancel" @click="editingKey = null" />
                    </form>
                    <span v-else class="project-signals__note">
                        <span v-if="row.note">{{ row.note }}</span>
                        <span v-else class="project-signals__missing">no note — who holds this key?</span>
                        <Button icon="pi pi-pencil" size="small" text severity="secondary" title="Edit the note" @click="startEdit(row)" />
                    </span>
                </template>
                <template #cell-last_used_at="{ row }">
                    <span :title="`minted ${fmt(row.created_at)}`">{{ row.last_used_at ? fmt(row.last_used_at) : "never" }}</span>
                </template>
                <template #cell-signals="{ row }">{{ row.signals_to_project ?? 0 }} / {{ row.signals_sent }}</template>
                <template #cell-actions="{ row }">
                    <Button icon="pi pi-ban" label="Revoke" size="small" severity="danger" text @click="confirmRevoke(row)" />
                </template>
            </DataList>

            <form class="project-signals__mint" @submit.prevent="mint">
                <InputText v-model="newLabel" placeholder="Source label, e.g. qdadm-chat" aria-label="Source label" />
                <InputText v-model="newNote" placeholder="Given to whom, and why" aria-label="Note" class="project-signals__mint-note" />
                <Button type="submit" icon="pi pi-key" label="Mint a key" :loading="minting" :disabled="!canMint" />
            </form>
        </section>
    </div>
</template>

<style scoped>
.project-signals {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
}
.project-signals__id {
    display: block;
    font-size: var(--fs-2xs);
    opacity: 0.5;
}
.project-signals__repeat {
    margin-left: 0.4rem;
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.project-signals__delivery {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin-right: 0.6rem;
}
.project-signals__muted,
.project-signals__missing {
    color: var(--p-text-muted-color);
    font-style: italic;
}
.project-signals__missing {
    color: var(--p-orange-600);
}
.project-signals__note,
.project-signals__note-edit {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.project-signals__note-edit {
    width: 100%;
}
.project-signals__mint {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-top: 0.8rem;
}
.project-signals__mint-note {
    flex: 1 1 18rem;
}
/* The token is on screen once: make it the thing that reads first. */
.project-signals__minted {
    margin-bottom: 1rem;
    padding: 0.8rem 1rem;
    border: 1px solid var(--p-orange-400);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--p-orange-400) 8%, transparent);
}
.project-signals__minted p {
    margin: 0 0 0.5rem;
}
.project-signals__token {
    display: block;
    font-family: var(--font-mono);
    word-break: break-all;
    user-select: all;
    margin-bottom: 0.6rem;
}
.project-signals__minted-actions {
    display: flex;
    gap: 0.6rem;
}
</style>
