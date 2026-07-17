<script setup lang="ts">
import { onMounted, ref } from "vue";
import AdminDetailLayout from "@kit/AdminDetailLayout.vue";
import AsyncState from "@kit/AsyncState.vue";
import FieldRow from "@kit/FieldRow.vue";
import FormField from "@kit/FormField.vue";
import { getWidget, saveWidget, type Widget, type WidgetStatus } from "./store";
import { canEdit } from "./session";

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const widget = ref<Widget | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const STATUSES: WidgetStatus[] = ["active", "draft", "retired"];

onMounted(async () => {
    try {
        widget.value = await getWidget(props.id);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
});

async function save(): Promise<void> {
    if (!widget.value) return;
    saving.value = true;
    saveError.value = null;
    try {
        widget.value = await saveWidget(widget.value);
    } catch (e) {
        saveError.value = e instanceof Error ? e.message : String(e);
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <AdminDetailLayout
        :crumbs="[{ label: 'Widgets' }]"
        :current="id"
        title="Edit widget"
        @close-to-inbox="emit('close')"
        @close-to-list="emit('close')"
    >
        <template #actions>
            <!-- The kit has no button. Every panel in the frontend reaches for
                 PrimeVue's <Button> here; the demo does the same, which is why
                 step 2 had to reopen step 1's bootstrap. -->
            <!-- Step 3: gated on a CLIENT-side mirror of the server's rule.
                 The kit offers nothing for this — no permission prop anywhere in
                 its ten components — so every caller re-invents the v-if. -->
            <Button
                v-if="canEdit"
                label="Save"
                size="small"
                :loading="saving"
                @click="save"
            />
        </template>

        <AsyncState :loading="loading" :error="error">
            <template v-if="widget">
                <FieldRow label="id">
                    <span class="aiball-mono">{{ widget.id }}</span>
                </FieldRow>
                <FieldRow label="last updated">{{ widget.updatedAt }}</FieldRow>

                <!-- Step 3, the expensive part. The kit splits read and write
                     into two unrelated components — FieldRow (label + value) and
                     FormField (label + slotted input) — with no read-only mode
                     on either. A page whose rights vary at runtime therefore
                     writes its whole body twice. There is no kit-level answer:
                     this duplication is what every permission-aware page pays. -->
                <template v-if="canEdit">
                    <FormField label="name" for="w-name">
                        <InputText id="w-name" v-model="widget.name" class="w-full" />
                    </FormField>

                    <FormField label="status" for="w-status">
                        <Select
                            id="w-status"
                            v-model="widget.status"
                            :options="STATUSES"
                            class="w-full"
                        />
                    </FormField>

                    <FormField label="owner" for="w-owner">
                        <InputText id="w-owner" v-model="widget.owner" class="w-full" />
                    </FormField>
                </template>
                <template v-else>
                    <FieldRow label="name">{{ widget.name }}</FieldRow>
                    <FieldRow label="status">{{ widget.status }}</FieldRow>
                    <FieldRow label="owner">{{ widget.owner }}</FieldRow>
                </template>

                <!-- A refusal has no home in the kit. AsyncState knows exactly
                     three states — loading / error / empty — so a 403 can only
                     be dressed as an error, in red, next to a network failure.
                     "You may not do this" and "the server broke" look identical
                     to the user, and the demo hand-rolls the colour either way. -->
                <p v-if="saveError" class="aiball-explainer" style="color: var(--p-red-500, #ef4444)">
                    {{ saveError }}
                </p>
            </template>
        </AsyncState>
    </AdminDetailLayout>
</template>
