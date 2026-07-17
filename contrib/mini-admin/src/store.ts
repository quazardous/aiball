import { ref } from "vue";

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

export async function saveWidget(patch: Widget): Promise<Widget> {
    await latency();
    if (!patch.name.trim()) throw new Error("name is required");
    const i = rows.value.findIndex((w) => w.id === patch.id);
    if (i < 0) throw new Error(`no widget ${patch.id}`);
    rows.value[i] = { ...patch, updatedAt: new Date().toISOString().slice(0, 10) };
    return { ...rows.value[i] };
}
