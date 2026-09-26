// #3099 — switching project while a page read is in flight: the old project's
// page, answered last, must not replace the new one's.
import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import { api, type InboxRow } from "./api";
import { useInboxCache } from "./inbox-cache";

test("a page answered after a newer read was asked does not land", async () => {
    const answers: Array<(rows: InboxRow[]) => void> = [];
    (api as unknown as { inbox: unknown }).inbox = () => new Promise((resolve) => {
        answers.push((rows) => resolve({ rows, total: rows.length }));
    });
    const project = ref<string | null>("old");
    const cache = useInboxCache({
        filters: {
            statusFilter: ref("all"), project, onlyOpen: ref(true), showSnoozed: ref(false),
            priorityFilter: ref("all"), sortBy: ref("activity"), page: ref(1), pageSize: ref(25),
        } as never,
        enabled: ref(true),
    });
    const oldRead = cache.fetchPage();
    project.value = "new";
    const newRead = cache.fetchPage();
    answers[1]!([{ id: 2 } as InboxRow]); // the new project answers first
    await newRead;
    answers[0]!([{ id: 1 } as InboxRow]); // then the old one
    await oldRead;
    assert.deepEqual(cache.rows.value.map((r) => r.id), [2], "the new project's page stays");
});
