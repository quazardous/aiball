/**
 * Paste-image handler for any textarea (per #B.76). Wires a `paste`
 * listener that intercepts `image/*` clipboard items, uploads them via
 * `uploadImage`, and inserts a markdown `![pasted](/uploads/<sha>.<ext>)`
 * reference at the textarea's caret position.
 *
 * Usage from a Vue component:
 *
 *   const ta = ref<HTMLTextAreaElement | null>(null);
 *   onMounted(() => {
 *     if (ta.value) attachPasteImage(ta.value, body, onError);
 *   });
 *
 * Returns a `detach()` for explicit cleanup if needed; the listener
 * is added/removed automatically when the element mounts/unmounts in
 * normal Vue usage so most callers don't need to call it.
 */
import { uploadImage, isUploadableImage } from "./upload";

export interface PasteImageOptions {
    /** Called on any error so the host can show a toast / inline message. */
    onError?: (err: Error) => void;
    /** Called right after a successful insert. Useful to refocus / scroll. */
    onSuccess?: (url: string) => void;
}

/**
 * Wire a paste listener on `el`. `bodyRef` is the parent's reactive
 * body model — we mutate it in place and let Vue re-render. The
 * caret position from the textarea is preserved when inserting the
 * `![](…)` snippet at the current cursor.
 */
export function attachPasteImage(
    el: HTMLTextAreaElement,
    bodyRef: { value: string },
    opts: PasteImageOptions = {},
): () => void {
    const handler = async (ev: ClipboardEvent) => {
        const items = ev.clipboardData?.items;
        if (!items) return;
        const imageItem = Array.from(items).find(
            (it) => it.kind === "file" && it.type.startsWith("image/"),
        );
        if (!imageItem) return;
        const file = imageItem.getAsFile();
        if (!file) return;
        if (!isUploadableImage(file)) {
            // Let the browser fall through with the default (text/uri or
            // similar) — we only intercept allowed image types.
            return;
        }
        ev.preventDefault();
        // Capture caret BEFORE the await so the position survives the
        // async upload (the user may have clicked elsewhere in the
        // meantime; in that case we fall back to the end of the body).
        const start = el.selectionStart ?? bodyRef.value.length;
        const end = el.selectionEnd ?? bodyRef.value.length;
        try {
            const { url } = await uploadImage(file);
            const snippet = `![pasted](${url})`;
            const before = bodyRef.value.slice(0, start);
            const after = bodyRef.value.slice(end);
            bodyRef.value = `${before}${snippet}${after}`;
            // Vue updates the textarea value next tick; restore caret
            // to right after the inserted snippet so the next keystroke
            // continues on the same line.
            queueMicrotask(() => {
                const caret = start + snippet.length;
                try {
                    el.setSelectionRange(caret, caret);
                    el.focus();
                } catch {
                    /* element may be unmounted — ignore */
                }
            });
            opts.onSuccess?.(url);
        } catch (e) {
            opts.onError?.(e as Error);
        }
    };
    el.addEventListener("paste", handler);
    return () => el.removeEventListener("paste", handler);
}
