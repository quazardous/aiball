/**
 * #504 — sources de données pour l'autocomplete des leaves automation
 * (`ConditionLeafBlock`). Une seule fetch au mount de l'éditeur, partagée
 * via `provide`/`inject` aux leaves : pas de N+1 si on a 10 leaves.
 *
 * Catégories :
 *  - `projects` (depuis `/api/mention-suggestions`)
 *  - `agents`   (idem — known agents = ceux qui ont posté ; suffit pour `by_agent`)
 *  - `tags`     (depuis `/api/tags`, on remonte les `name`)
 *  - `consumers` (depuis `/api/consumers`, on remonte les `consumer_id`)
 */
import { ref, type Ref, type InjectionKey } from "vue";
import { api, type Tag } from "./api";

export interface LeafSources {
    projects: Ref<string[]>;
    agents: Ref<string[]>;
    /** Noms seuls — utile pour AutoComplete textuelle. */
    tags: Ref<string[]>;
    /** Tags complets (avec color, pour le rendu en TagBadge chip row, #504 `ftj93r`). */
    tagObjects: Ref<Tag[]>;
    consumers: Ref<string[]>;
    loading: Ref<boolean>;
    error: Ref<string | null>;
    refresh: () => Promise<void>;
}

export const LEAF_SOURCES_KEY: InjectionKey<LeafSources> = Symbol("leaf-sources");

export function createLeafSources(): LeafSources {
    const projects = ref<string[]>([]);
    const agents = ref<string[]>([]);
    const tags = ref<string[]>([]);
    const tagObjects = ref<Tag[]>([]);
    const consumers = ref<string[]>([]);
    const loading = ref(false);
    const error = ref<string | null>(null);

    async function refresh(): Promise<void> {
        loading.value = true;
        error.value = null;
        try {
            const [mention, tagRows, consumerRows] = await Promise.all([
                api.mentionSuggestions(),
                api.listTags(),
                api.listConsumers(),
            ]);
            projects.value = mention.projects ?? [];
            agents.value = mention.agents ?? [];
            tagObjects.value = tagRows ?? [];
            tags.value = (tagRows ?? []).map((t) => t.name);
            consumers.value = (consumerRows ?? []).map((c) => c.consumer_id);
        } catch (e) {
            error.value = e instanceof Error ? e.message : String(e);
        } finally {
            loading.value = false;
        }
    }

    return { projects, agents, tags, tagObjects, consumers, loading, error, refresh };
}
