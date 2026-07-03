/**
 * useLoader — the shared async-load wrapper (UI-audit C2, slice 1).
 *
 * Collapses the pattern that was copy-pasted across ~25 components :
 *
 *   loading.value = true; [error.value = null;]
 *   try { ...await api... }
 *   catch (e) { toast.add(...) OU error.value = (e as Error).message }
 *   finally { loading.value = false; }
 *
 * plus the usual wiring around it (`onMounted(load)`, `useBus("x.refresh",
 * () => void load())`).
 *
 * Two error styles, mutually exclusive per call-site (matching the two
 * variants found in the audit) :
 *   - default : `error` ref filled with the message (the ~18-file variant) ;
 *   - `onError` : callback instead (the toast variant — keeps PrimeVue's
 *     toast service out of this lib ; the component passes its own closure).
 *
 * `showLoading` is the keep-stale-while-refetching hook (#472 : flipping
 * `loading` on a bus-driven refresh unmounted ConsumerEditPage's subtree and
 * re-created the terminal). Pass `() => !data.value` so only the FIRST load
 * shows the spinner ; later refreshes keep the stale UI rendered while the
 * request runs.
 */
import { onMounted, type Ref, ref } from "vue";
import { type BusEvents, useBus } from "./bus";

/** Bus events with a void payload — the only ones `refreshOn` can wire. */
type VoidBusEvent = {
    [K in keyof BusEvents]: BusEvents[K] extends void ? K : never;
}[keyof BusEvents];

export interface UseLoaderOptions {
    /** Failure callback INSTEAD of filling `error` (the toast variant). */
    onError?: (message: string, e: unknown) => void;
    /** Share an existing error ref (a screen with several loaders keeps one
     *  error surface). Default: a fresh ref. */
    error?: Ref<string | null>;
    /** Flip `loading` only when this returns true. Keep-stale mode : pass
     *  `() => !data.value` (see module doc). Default: always flip. */
    showLoading?: () => boolean;
    /** Void bus events that re-run `load` (replaces the hand-rolled
     *  `useBus("x.refresh", () => void load())` lines). */
    refreshOn?: VoidBusEvent[];
    /** Run `load` on component mount. Default false (some components batch
     *  several calls in their own onMounted). */
    mountLoad?: boolean;
}

export function useLoader(fetcher: () => Promise<void>, opts: UseLoaderOptions = {}): {
    loading: Ref<boolean>;
    error: Ref<string | null>;
    load: () => Promise<void>;
} {
    const loading = ref(false);
    const error = opts.error ?? ref<string | null>(null);

    async function load(): Promise<void> {
        if (!opts.showLoading || opts.showLoading()) loading.value = true;
        error.value = null;
        try {
            await fetcher();
        } catch (e) {
            const message = (e as Error).message;
            if (opts.onError) opts.onError(message, e);
            else error.value = message;
        } finally {
            loading.value = false;
        }
    }

    for (const ev of opts.refreshOn ?? []) {
        useBus(ev, () => { void load(); });
    }
    if (opts.mountLoad) onMounted(() => { void load(); });

    return { loading, error, load };
}
