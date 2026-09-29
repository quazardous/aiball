// #3288 — the model catalog: read from open lists (no key), a newer model of the same family told by its version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3288-"));
process.env.AIBALL_SOCK = "";
const { familyOf, modelFacts, parseLiteLLM, parseModelsDev, setModelCatalogForTests } = await import("./model-catalog.js");
const { setAgentBar, getAgentBar, __resetAgentBars } = await import("./agent-bar-store.js");

// The shapes the two lists have (models.dev's api.json, LiteLLM's price table), cut down.
const MODELS_DEV = { anthropic: { models: {
    "claude-opus-5": { name: "Claude Opus 5", release_date: "2026-05-01", cost: { input: 5, output: 25 } },
    "claude-opus-5-5": { name: "Claude Opus 5.5", release_date: "2026-09-22", cost: { input: 4, output: 20 } },
    "claude-sonnet-4-5-20250929": { name: "Claude Sonnet 4.5", release_date: "2025-09-29", cost: { input: 3, output: 15 } },
    "claude-sonnet-4-5": { name: "Claude Sonnet 4.5 (latest)", release_date: "2025-09-29", cost: { input: 3, output: 15 } },
    "claude-haiku-4-5": { name: "Claude Haiku 4.5", release_date: "2025-10-01" },
} } };
const LITELLM = {
    "claude-opus-5": { litellm_provider: "anthropic", input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
    "gpt-x": { litellm_provider: "openai", input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
};

test("a model id reads as a family and a version", () => {
    assert.deepEqual(familyOf("claude-opus-5-5"), { family: "Opus", version: [5, 5] });
    assert.deepEqual(familyOf("claude-haiku-4-5-20251001"), { family: "Haiku", version: [4, 5] });
    assert.deepEqual(familyOf("claude-opus-5-5[1m]"), { family: "Opus", version: [5, 5] });
    assert.equal(familyOf("<synthetic>"), null);
});

test("both lists read: models.dev with dates and prices, LiteLLM priced per token; a dated duplicate kept once", () => {
    const md = parseModelsDev(MODELS_DEV);
    assert.deepEqual(md.map((m) => m.id).sort(), ["claude-haiku-4-5", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-5"]);
    assert.deepEqual(md.find((m) => m.id === "claude-opus-5-5")!.cost, { input: 4, output: 20 });
    assert.equal(md.find((m) => m.id === "claude-haiku-4-5")!.cost, null, "no price said: none");
    assert.deepEqual(parseLiteLLM(LITELLM).map((m) => [m.id, m.cost]), [["claude-opus-5", { input: 5, output: 25 }]], "only Anthropic's");
});

test("a newer model of the same family, and the price of the one running", () => {
    setModelCatalogForTests({ source: "models.dev", fetched_at: "2026-09-29T00:00:00Z", models: parseModelsDev(MODELS_DEV) });
    const on5 = modelFacts("claude-opus-5")!;
    assert.deepEqual(on5.cost, { input: 5, output: 25 });
    assert.deepEqual(on5.newer, { id: "claude-opus-5-5", name: "Opus 5.5", cost: { input: 4, output: 20 } });
    assert.equal(on5.source, "models.dev");
    assert.equal(modelFacts("claude-opus-5-5")!.newer, null, "the newest of its family");
    assert.equal(modelFacts("claude-sonnet-4-5-20250929")!.newer, null, "no newer Sonnet in the list");
    assert.equal(modelFacts("claude-mystery-9")!.cost, null, "unknown to the list: nothing said of it");
    setModelCatalogForTests(null);
    assert.equal(modelFacts("claude-opus-5"), null, "no catalog: nothing");
});

test("the bar a host reads carries the price and the newer model; a catalog loaded after the push still applies", () => {
    __resetAgentBars();
    setModelCatalogForTests(null);
    setAgentBar("worker", { phase: "idle", model: { id: "claude-opus-5", name: "Opus 5" } } as never);
    assert.deepEqual(getAgentBar("worker")!.bar.model, { id: "claude-opus-5", name: "Opus 5" }, "no catalog yet: as pushed");
    setModelCatalogForTests({ source: "models.dev", fetched_at: "2026-09-29T00:00:00Z", models: parseModelsDev(MODELS_DEV) });
    const m = getAgentBar("worker")!.bar.model!;
    assert.equal(m.newer?.name, "Opus 5.5");
    assert.deepEqual(m.cost, { input: 5, output: 25 });
    assert.equal(m.catalog, "models.dev");
    setModelCatalogForTests(null);
});
