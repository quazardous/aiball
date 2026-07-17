<script setup lang="ts">
import { onMounted, ref } from "vue";
import AdminDetailLayout from "@kit/AdminDetailLayout.vue";
import AsyncState from "@kit/AsyncState.vue";
import FieldRow from "@kit/FieldRow.vue";
import FormField from "@kit/FormField.vue";
import { getWidget, saveWidget, type Widget, type WidgetStatus } from "./store";

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
            <Button label="Save" size="small" :loading="saving" @click="save" />
        </template>

        <AsyncState :loading="loading" :error="error">
            <template v-if="widget">
                <FieldRow label="id">
                    <span class="aiball-mono">{{ widget.id }}</span>
                </FieldRow>
                <FieldRow label="last updated">{{ widget.updatedAt }}</FieldRow>

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

                <p v-if="saveError" class="aiball-explainer" style="color: var(--p-red-500, #ef4444)">
                    {{ saveError }}
                </p>
            </template>
        </AsyncState>
    </AdminDetailLayout>
</template>
