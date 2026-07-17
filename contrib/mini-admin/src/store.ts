import { ref } from "vue";
import { canEdit, ForbiddenError } from "./session";

// The demo has no backend on purpose: the tutorial is about the UI kit, not
// about wiring an API. This fake store keeps the async shape (promises, a
// latency, failures are possible) so the screens use AsyncState for real.

export type WidgetStatus = "active" | "draft" | "retired";

export interface Widget {
    id: string;
    name: string;
    status: WidgetStatus;
    owner: string;
    updatedAt: string;
}

const rows = ref<Widget[]>([
    { id: "wd-001", name: "Sprocket", status: "active", owner: "ada", updatedAt: "2026-07-14" },
    { id: "wd-002", name: "Flange", status: "draft", owner: "linus", updatedAt: "2026-07-15" },
    { id: "wd-003", name: "Grommet", status: "active", owner: "ada", updatedAt: "2026-07-16" },
    { id: "wd-004", name: "Bearing", status: "retired", owner: "grace", updatedAt: "2026-06-02" },
]);

// Step 5 — children. A widget is made of parts.
export interface Part {
    id: string;
    widgetId: string;
    name: string;
    qty: number;
}

const parts = ref<Part[]>([
    { id: "pt-01", widgetId: "wd-001", name: "Cog", qty: 4 },
    { id: "pt-02", widgetId: "wd-001", name: "Spring", qty: 2 },
    { id: "pt-03", widgetId: "wd-002", name: "Plate", qty: 1 },
    { id: "pt-04", widgetId: "wd-003", name: "Rivet", qty: 12 },
]);

const latency = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

export async function listWidgets(): Promise<Widget[]> {
    await latency();
    return rows.value.slice();
}

export async function getWidget(id: string): Promise<Widget> {
    await latency();
    const found = rows.value.find((w) => w.id === id);
    if (!found) throw new Error(`no widget ${id}`);
    return { ...found };
}

export async function listParts(widgetId: string): Promise<Part[]> {
    await latency();
    return parts.value.filter((p) => p.widgetId === widgetId);
}

export async function getPart(id: string): Promise<Part> {
    await latency();
    const found = parts.value.find((p) => p.id === id);
    if (!found) throw new Error(`no part ${id}`);
    return { ...found };
}

export async function savePart(patch: Part): Promise<Part> {
    await latency();
    // Step 5: the rule does NOT cascade on its own — the child re-states the
    // parent's permission by hand. Nothing in session.ts models ownership, so
    // "may I edit this widget's parts?" has no answer but a copy of the rule.
    if (!canEdit.value) throw new ForbiddenError("save a part");
    const i = parts.value.findIndex((p) => p.id === patch.id);
    if (i < 0) throw new Error(`no part ${patch.id}`);
    parts.value[i] = { ...patch };
    return { ...parts.value[i] };
}

export async function saveWidget(patch: Widget): Promise<Widget> {
    await latency();
    // Step 3 — the server is the one that refuses, exactly like aiball's routes.
    if (!canEdit.value) throw new ForbiddenError("save a widget");
    if (!patch.name.trim()) throw new Error("name is required");
    const i = rows.value.findIndex((w) => w.id === patch.id);
    if (i < 0) throw new Error(`no widget ${patch.id}`);
    rows.value[i] = { ...patch, updatedAt: new Date().toISOString().slice(0, 10) };
    return { ...rows.value[i] };
}
