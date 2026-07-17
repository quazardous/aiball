<script setup lang="ts">
import { onMounted, ref } from "vue";
import AdminDetailLayout from "@kit/AdminDetailLayout.vue";
import AsyncState from "@kit/AsyncState.vue";
import FieldRow from "@kit/FieldRow.vue";
import FormField from "@kit/FormField.vue";
import { getPart, savePart, type Part } from "./store";
import { canEdit } from "./session";
import { crumbs } from "./router";

const props = defineProps<{ partId: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const part = ref<Part | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

onMounted(async () => {
    try {
        part.value = await getPart(props.partId);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
});

async function save(): Promise<void> {
    if (!part.value) return;
    saving.value = true;
    saveError.value = null;
    try {
        part.value = await savePart(part.value);
    } catch (e) {
        saveError.value = e instanceof Error ? e.message : String(e);
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <!-- Step 5 vs step 4: a three-level chain (Widgets > wd-001 > Parts). It
         only renders correctly because step 5 had to go back and fix the crumb
         builder — its parent links were emitted as the literal `/widgets/:id`. -->
    <AdminDetailLayout
        :crumbs="crumbs"
        :current="partId"
        title="Edit part"
        @close-to-inbox="emit('close')"
        @close-to-list="emit('close')"
    >
        <template #actions>
            <!-- Step 5 vs step 3: the permission does NOT cascade. `canEdit` is
                 a flat global — it knows nothing of "this widget" or "its
                 parts", so the child restates the parent's rule verbatim. With
                 per-entity ownership this v-if would be a lie. -->
            <Button
                v-if="canEdit"
                label="Save"
                size="small"
                :loading="saving"
                @click="save"
            />
        </template>

        <AsyncState :loading="loading" :error="error">
            <template v-if="part">
                <FieldRow label="id">
                    <span class="aiball-mono">{{ part.id }}</span>
                </FieldRow>
                <FieldRow label="belongs to">
                    <span class="aiball-mono">{{ part.widgetId }}</span>
                </FieldRow>

                <!-- The step-3 duplication, paid a second time. Every
                     permission-aware page writes its body twice, forever. -->
                <template v-if="canEdit">
                    <FormField label="name" for="p-name">
                        <InputText id="p-name" v-model="part.name" class="w-full" />
                    </FormField>
                    <FormField label="qty" for="p-qty">
                        <InputNumber id="p-qty" v-model="part.qty" class="w-full" />
                    </FormField>
                </template>
                <template v-else>
                    <FieldRow label="name">{{ part.name }}</FieldRow>
                    <FieldRow label="qty">{{ part.qty }}</FieldRow>
                </template>

                <p v-if="saveError" class="aiball-explainer" style="color: var(--p-red-500, #ef4444)">
                    {{ saveError }}
                </p>
            </template>
        </AsyncState>
    </AdminDetailLayout>
</template>
