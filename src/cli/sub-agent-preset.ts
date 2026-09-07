/**
 * What `--sub-agent` fills in, and what it refuses to overrule.
 *
 * Extracted from `bootstrapInit` for the same reason `sub-agent-name.ts` was:
 * the preset decides an agent's standing in the project, and inline in a
 * 200-line async function it was reachable by no test. That mattered — the
 * first version set `no_claim` and stopped there, which looks complete and
 * is not.
 *
 * **Why `role` belongs here.** `no_claim` and the subscription role are two
 * independent axes. `no_claim` shuts the claim door; it says nothing about who
 * the daemon fans events out to. `subscriptionRoleFor` maps anything that is
 * not `crew` to `owner`, and default-scope events go to ticket subscribers,
 * @mentions **and project owners** — so a sub-agent seeded with `no_claim`
 * alone still received the entire project backlog, exactly like the maintainer
 * it was meant to work under. It could not claim any of it, which made the
 * symptom look like a wake-filtering bug rather than an identity one.
 *
 * `crew` is the pairing #1435 already defined for this — follower subscription
 * plus assignment-only — so the preset seeds that rather than inventing a
 * third axis.
 */

export type ConsumerRole = "lead" | "crew";

/** The two roles, in one place, so the flag and the reader agree on them. */
export const CONSUMER_ROLES: readonly ConsumerRole[] = ["lead", "crew"];

/**
 * Whether a value is a role the runtime will actually honour.
 *
 * The flag takes a free string, and `autopoll/config.ts` accepts only `lead`
 * and `crew` — anything else leaves the resolved role NULL, which behaves as
 * lead. So a typo would be written into the yaml, displayed back, and then
 * quietly ignored: the file claims a standing the daemon does not give. That
 * is the same silent shape this whole fix is about, one layer up, and it is
 * cheaper to refuse than to explain.
 */
export function isConsumerRole(v: unknown): v is ConsumerRole {
    return typeof v === "string" && (CONSUMER_ROLES as readonly string[]).includes(v);
}

export interface SubAgentGiven {
    /** `--agent` / `--consumer`, when the user gave an id explicitly. */
    consumer?: string;
    /** `--no-claim`, when passed. */
    noClaim?: boolean;
    /** `--role`, when passed. */
    role?: ConsumerRole;
    /**
     * The id already written in this checkout's `.aiball.yaml`, if any.
     *
     * Re-running `--sub-agent` on a project that already has one must NOT
     * change it (david `<chat>`: "si on relance claude-loop --sub-agent et que
     * le nom est deja set on le re ecrase pas"). A consumer id is an identity
     * the daemon has rows against — tickets authored, subscriptions, assignment
     * history — so silently deriving a fresh one would orphan all of it, and
     * the derivation is host-dependent, meaning the same checkout re-inited
     * from a different machine would drift to a different agent.
     */
    yamlConsumer?: string | null;
}

export interface SubAgentResolved {
    consumer: string;
    noClaim: boolean;
    role: ConsumerRole;
}

/**
 * Resolve what `--sub-agent` should write, given what was asked for explicitly.
 *
 * The rule is fill-the-blanks, never overrule: an explicit `--agent`,
 * `--no-claim` or `--role` wins, because the preset is sugar for the common
 * case and not a policy.
 *
 * The id resolves in decreasing order of how deliberate it is:
 *
 *   1. `--agent <id>` — typed on this command line, so it is the intent now;
 *   2. the id after `--sub-agent <id>` — also typed on this command line, so
 *      the two spellings are equivalent by construction;
 *   3. `consumer.agent` already in `.aiball.yaml` — a decision made earlier
 *      that a re-run has no business undoing (#612's rule: init respects what
 *      is already set unless a flag says otherwise);
 *   4. the derivation, for a genuinely new sub-agent.
 *
 * `derive` is called only when it is actually reached, so a caller need not
 * compute an id it will not use.
 */
export function resolveSubAgentPreset(
    given: SubAgentGiven,
    subAgent: string | boolean,
    derive: () => string,
): SubAgentResolved {
    const named = typeof subAgent === "string" ? subAgent.trim() : "";
    return {
        consumer: given.consumer || named || given.yamlConsumer?.trim() || derive(),
        noClaim: given.noClaim ?? true,
        role: given.role ?? "crew",
    };
}
