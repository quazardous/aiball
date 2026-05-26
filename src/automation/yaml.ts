/**
 * #457 slice 3 — YAML loader for automation rules.
 *
 * Layered "russian-doll" reader (mirrors `config-tags.ts`) :
 *
 *   1. global       ~/.config/aiball/config.yaml   → automation:
 *   2. per-project  <cwd>/.aiball.yaml             → automation:
 *
 * Each layer is a LIST of rule entries — concatenated lowest→highest. The
 * resulting list is appended AFTER the DB rules in the engine's candidate
 * pool (operators set rules in the UI to OVERRIDE versioned YAML
 * defaults — same precedence direction as the other config concerns).
 *
 * Synthetic ids : YAML rules carry **negative ids** (decremented as we read)
 * so the UI / engine can identify the source. The DB autoincrement is
 * unsigned-leaning (always positive), so the two ID spaces never collide.
 *
 * Failure mode : a malformed entry is SKIPPED with a `console.warn`, never
 * fails the whole load — defensive, since YAML hand-edits are common and
 * one bad rule shouldn't kill all the others.
 *
 * Shape consumed (slice 2 `assign` example) :
 *
 *   automation:
 *     - name: "Win tickets to Windows agent"
 *       triggers: [ticket_created, ticket_tagged]
 *       when:
 *         project: aiball                    # match_project
 *         has_tags: [win]                    # match_tags any-of
 *         tag_added: win                     # match_tag_added (ticket_tagged only)
 *         by_agent: someone                  # match_by_agent
 *         kind: ticket_created               # match_kind (message_posted only)
 *         intent: request                    # match_intent
 *         priority: urgent                   # match_priority
 *         scope_consumer: agent-A            # narrows actionable_eval to A
 *       do:
 *         assign_to: aiball-windows          # action.kind="assign"
 *       enabled: true                        # optional, default true
 *       note: "free text"                    # optional
 *
 * Alternate `do:` shapes :
 *   - `decision: auto | review`          → action.kind="decision"
 *   - `pickup:   only | except`          → action.kind="pickup"
 *   - `add_tag:  <tagname>`              → action.kind="add_tag"
 *   - `set_priority: urgent|high|normal|low` → action.kind="set_priority"
 *   - `notify:   <consumer_id>`          → action.kind="notify"
 *
 * The DB schema is the authoritative type — the YAML shape is just a
 * human-friendlier surface that we decode into the same `AutomationRule`
 * record.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { findConfigUpwards, globalConfigPath } from "../autopoll/config.js";
import type {
    AutomationAction,
    AutomationRule,
    Trigger,
} from "../db/automation.js";
import { synthesizeLegacyExpression } from "../db/automation.js";

const VALID_TRIGGERS: Trigger[] = [
    "message_posted",
    "actionable_eval",
    "ticket_created",
    "ticket_tagged",
];

const VALID_PRIORITIES = ["urgent", "high", "normal", "low"] as const;

/** Convert one parsed YAML map entry to an AutomationRule. Null on malformed. */
function parseEntry(raw: unknown, syntheticId: number, source: string): AutomationRule | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;

    // Triggers : accept a single string or a list.
    const rawTriggers = o.triggers ?? o.trigger; // tolerate the singular alias
    const triggerList: Trigger[] = [];
    if (typeof rawTriggers === "string") {
        if ((VALID_TRIGGERS as string[]).includes(rawTriggers)) {
            triggerList.push(rawTriggers as Trigger);
        }
    } else if (Array.isArray(rawTriggers)) {
        for (const t of rawTriggers) {
            if (typeof t === "string" && (VALID_TRIGGERS as string[]).includes(t)) {
                triggerList.push(t as Trigger);
            }
        }
    }
    if (triggerList.length === 0) {
        console.warn(`[automation/yaml] ${source} : skipping rule — no valid trigger`);
        return null;
    }

    // Action(s) : `do:` can be a single action map (legacy syntax) OR an
    // array of action maps (slice 5.4 stack — david `aa48pd`). The first
    // surviving action populates the back-compat `action` field ; the
    // full sequence lands in `actions`.
    const rawDo = o.do;
    const actionList: AutomationAction[] = [];
    if (Array.isArray(rawDo)) {
        for (const entry of rawDo) {
            const a = decodeAction(entry, source);
            if (a) actionList.push(a);
        }
    } else {
        const a = decodeAction(rawDo, source);
        if (a) actionList.push(a);
    }
    if (actionList.length === 0) return null;
    const action = actionList[0]!;

    // Conditions : everything under `when:` (with sensible default empty).
    const when = (o.when && typeof o.when === "object" ? o.when : {}) as Record<string, unknown>;
    const match_tags = Array.isArray(when.has_tags)
        ? (when.has_tags as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
    const matchPriority =
        typeof when.priority === "string" && (VALID_PRIORITIES as readonly string[]).includes(when.priority)
            ? when.priority
            : null;

    const enabled = o.enabled === false ? 0 : 1;
    const note = typeof o.note === "string" ? o.note : typeof o.name === "string" ? o.name : null;

    // #457 slice 5.1 : YAML rules carry the same `expression` tree as DB
    // rules. For this slice we synthesize from the legacy-shaped `when:`
    // block ; slice 5.2 will add a richer YAML grammar for explicit AND/OR
    // composition (`any:` / `all:` blocks).
    const matchProject = typeof when.project === "string" ? when.project : null;
    const matchKind = typeof when.kind === "string" ? when.kind : null;
    const matchByAgent = typeof when.by_agent === "string" ? when.by_agent : null;
    const matchTagAdded = typeof when.tag_added === "string" ? when.tag_added : null;
    const matchIntent = typeof when.intent === "string" ? when.intent : null;
    const scopeConsumer = typeof when.scope_consumer === "string" ? when.scope_consumer : null;
    const expression = synthesizeLegacyExpression({
        match_project: matchProject,
        match_kind: matchKind,
        match_by_agent: matchByAgent,
        match_intent: matchIntent,
        match_priority: matchPriority,
        match_tag_added: matchTagAdded,
        match_tags,
        scope_consumer: scopeConsumer,
    });

    return {
        id: syntheticId,
        triggers: triggerList,
        scope_consumer: scopeConsumer,
        match_project: matchProject,
        match_kind: matchKind,
        match_by_agent: matchByAgent,
        match_tags,
        match_tag_added: matchTagAdded,
        match_intent: matchIntent,
        match_priority: matchPriority,
        action,
        // Slice 5.4 — full stack from `do:` (legacy single map or array).
        actions: actionList,
        enabled,
        expression,
        position: 0, // YAML order is the position — caller iterates in load order.
        note,
        created_at: "yaml", // sentinel — YAML rules have no DB row.
    };
}

function decodeAction(raw: unknown, source: string): AutomationAction | null {
    if (!raw || typeof raw !== "object") {
        console.warn(`[automation/yaml] ${source} : skipping rule — missing 'do:' block`);
        return null;
    }
    const d = raw as Record<string, unknown>;
    if (typeof d.assign_to === "string" && d.assign_to.trim()) {
        return { kind: "assign", consumer_id: d.assign_to.trim() };
    }
    if (d.decision === "auto" || d.decision === "review") {
        return { kind: "decision", decision: d.decision };
    }
    if (d.pickup === "only" || d.pickup === "except") {
        return { kind: "pickup", mode: d.pickup };
    }
    if (typeof d.add_tag === "string" && d.add_tag.trim()) {
        return { kind: "add_tag", tag: d.add_tag.trim() };
    }
    if (typeof d.set_priority === "string"
        && (VALID_PRIORITIES as readonly string[]).includes(d.set_priority)) {
        return { kind: "set_priority", priority: d.set_priority as typeof VALID_PRIORITIES[number] };
    }
    if (typeof d.notify === "string" && d.notify.trim()) {
        return { kind: "notify", consumer_id: d.notify.trim() };
    }
    console.warn(`[automation/yaml] ${source} : skipping rule — unrecognized 'do:' shape`);
    return null;
}

/**
 * Pure parse step (testable without filesystem) : take the raw `automation:`
 * value from a YAML layer + a starting synthetic id, return the rule list +
 * the next available id.
 */
export function parseAutomationBlock(
    block: unknown,
    startId: number,
    source: string,
): { rules: AutomationRule[]; nextId: number } {
    if (!Array.isArray(block)) return { rules: [], nextId: startId };
    const rules: AutomationRule[] = [];
    let id = startId;
    for (const entry of block) {
        const r = parseEntry(entry, id, source);
        if (r) {
            rules.push(r);
            id--;
        }
    }
    return { rules, nextId: id };
}

function readAutomationLayer(path: string, startId: number): { rules: AutomationRule[]; nextId: number } {
    if (!existsSync(path)) return { rules: [], nextId: startId };
    try {
        const parsed = parseYaml(readFileSync(path, "utf8")) as { automation?: unknown } | null;
        return parseAutomationBlock(parsed?.automation, startId, path);
    } catch (e) {
        console.warn(`[automation/yaml] ${path} : parse error, ignored :`, e);
        return { rules: [], nextId: startId };
    }
}

/**
 * Read all YAML layers (global + per-project, in that order). Concatenated
 * lowest→highest priority — within a single first-match-wins iteration that
 * means global rules are TRIED FIRST among the YAML rules, then per-project
 * ones. Operators who want a project rule to take precedence over a global
 * one should use the UI (DB rules come BEFORE all YAML rules in the engine's
 * candidate list).
 *
 * Synthetic ids start at -1 and decrement, so all YAML ids stay < 0
 * (DB autoincrement is positive — no collision).
 */
export function loadYamlAutomationRules(): AutomationRule[] {
    let id = -1;
    const global = readAutomationLayer(globalConfigPath(), id);
    id = global.nextId;
    const projectPath = findConfigUpwards(process.cwd());
    const project = projectPath ? readAutomationLayer(projectPath, id) : { rules: [] as AutomationRule[], nextId: id };
    return [...global.rules, ...project.rules];
}
