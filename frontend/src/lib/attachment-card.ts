/**
 * #723 — render `/uploads/<sha>.<ext>` links in rendered markdown as
 * compact "attachment cards" with a Download button + (when the type
 * is previewable) a collapsible inline preview. Driven post-render
 * from `MarkdownView`, same style as `wireCopyButtons` / `wireQuestionClicks`.
 *
 * Images (`png|jpg|jpeg|gif|webp`) are already rendered as `<img>` by
 * marked, so they are not handled here — only `<a href="/uploads/…">`.
 *
 * The card is built imperatively (createElement + textContent) — no
 * `innerHTML` on fetched bytes, so a malformed `.json` / `.md` can't
 * inject markup. The markdown preview path runs the fetched body
 * through the same `marked + DOMPurify` pipeline as the rest of the
 * bodies (caller passes `renderMarkdown`).
 */
import DOMPurify from "dompurify";
import { highlightCode } from "./highlight";

const UPLOAD_PREFIX = "/uploads/";

const PREVIEW_BYTE_CAP = 5 * 1024;   // 5 KB
const PREVIEW_LINE_CAP = 50;

const EXT_TO_LANG: Record<string, string> = {
    md: "markdown", txt: "", log: "",
    csv: "", json: "json",
    yaml: "yaml", yml: "yaml", toml: "ini",
    sh: "bash", bash: "bash",
    py: "python", ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    diff: "diff", patch: "diff",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const DL_ONLY_EXTS = new Set(["pdf", "tar", "gz", "tgz", "zip", "bin"]);

interface CardKind {
    /** "image" → skip (already an <img>). "preview" → text-preview card. "dl" → DL-only card. */
    kind: "image" | "preview" | "dl";
    ext: string;
    lang: string;
}

function classify(ext: string): CardKind {
    const low = ext.toLowerCase();
    if (IMAGE_EXTS.has(low)) return { kind: "image", ext: low, lang: "" };
    if (DL_ONLY_EXTS.has(low)) return { kind: "dl", ext: low, lang: "" };
    if (low in EXT_TO_LANG) return { kind: "preview", ext: low, lang: EXT_TO_LANG[low] };
    return { kind: "dl", ext: low, lang: "" };
}

function extOf(url: string): string {
    const m = /\/uploads\/[a-f0-9]{64}\.([a-zA-Z0-9]{1,8})/.exec(url);
    return m ? m[1] : "";
}

function formatBytes(n: number | null): string {
    if (n === null || !Number.isFinite(n)) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

interface FetchedPreview {
    text: string;
    truncated: boolean;
    bytes: number | null;
}

async function fetchPreview(url: string): Promise<FetchedPreview> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
    const cl = res.headers.get("content-length");
    const total = cl ? Number(cl) : null;
    const raw = await res.text();
    const byBytes = raw.length > PREVIEW_BYTE_CAP;
    const sliced = byBytes ? raw.slice(0, PREVIEW_BYTE_CAP) : raw;
    const lines = sliced.split("\n");
    const byLines = lines.length > PREVIEW_LINE_CAP;
    const text = byLines ? lines.slice(0, PREVIEW_LINE_CAP).join("\n") : sliced;
    return { text, truncated: byBytes || byLines, bytes: total ?? raw.length };
}

function buildCard(
    link: HTMLAnchorElement,
    cls: CardKind,
    renderMarkdown: (md: string) => string,
): HTMLElement {
    const url = link.getAttribute("href")!;
    const name = (link.textContent ?? "").trim() || `attachment.${cls.ext}`;

    const card = document.createElement("div");
    card.className = "aiball-attachment";
    card.dataset.ext = cls.ext;

    const row = document.createElement("div");
    row.className = "aiball-attachment__row";

    const icon = document.createElement("span");
    icon.className = "aiball-attachment__icon";
    icon.textContent = cls.kind === "preview" ? "📄" : "📎";
    row.appendChild(icon);

    const nameEl = document.createElement("span");
    nameEl.className = "aiball-attachment__name";
    nameEl.textContent = name;
    row.appendChild(nameEl);

    const sizeEl = document.createElement("span");
    sizeEl.className = "aiball-attachment__size";
    row.appendChild(sizeEl);

    const dl = document.createElement("a");
    dl.className = "aiball-attachment__dl";
    dl.href = url;
    dl.setAttribute("download", name);
    dl.setAttribute("rel", "noopener noreferrer");
    dl.textContent = "↓ Download";
    row.appendChild(dl);

    let toggle: HTMLButtonElement | null = null;
    let preview: HTMLElement | null = null;
    if (cls.kind === "preview") {
        toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "aiball-attachment__toggle";
        toggle.textContent = "Show preview";
        row.appendChild(toggle);

        preview = document.createElement("div");
        preview.className = "aiball-attachment__preview";
        preview.hidden = true;
    }

    card.appendChild(row);
    if (preview) card.appendChild(preview);

    if (toggle && preview) {
        let loaded = false;
        let loading = false;
        toggle.addEventListener("click", async () => {
            if (loading) return;
            if (preview!.hidden && !loaded) {
                loading = true;
                toggle!.textContent = "Loading…";
                try {
                    const fetched = await fetchPreview(url);
                    if (sizeEl.textContent === "" && fetched.bytes !== null) {
                        sizeEl.textContent = `— ${formatBytes(fetched.bytes)}`;
                    }
                    fillPreview(preview!, fetched, cls, renderMarkdown);
                    loaded = true;
                } catch (err) {
                    preview!.textContent = `(failed to load: ${(err as Error).message})`;
                } finally {
                    loading = false;
                }
            }
            preview!.hidden = !preview!.hidden;
            toggle!.textContent = preview!.hidden ? "Show preview" : "Hide preview";
        });
    }

    // Lazy size probe : HEAD request to fill the "— 4 KB" hint without
    // pulling the full body. Best-effort, silent on failure.
    void (async () => {
        try {
            const res = await fetch(url, { method: "HEAD" });
            const cl = res.headers.get("content-length");
            if (cl) sizeEl.textContent = `— ${formatBytes(Number(cl))}`;
        } catch { /* ignore */ }
    })();

    return card;
}

function fillPreview(
    preview: HTMLElement,
    fetched: FetchedPreview,
    cls: CardKind,
    renderMarkdown: (md: string) => string,
): void {
    preview.replaceChildren();
    if (cls.ext === "md") {
        const wrap = document.createElement("div");
        wrap.className = "md-body aiball-attachment__md";
        const html = DOMPurify.sanitize(renderMarkdown(fetched.text));
        wrap.innerHTML = html;
        preview.appendChild(wrap);
    } else {
        const pre = document.createElement("pre");
        pre.className = "aiball-attachment__code";
        const code = document.createElement("code");
        code.className = cls.lang ? `hljs language-${cls.lang}` : "hljs";
        if (cls.lang) {
            code.innerHTML = highlightCode(fetched.text, cls.lang);
        } else {
            code.textContent = fetched.text;
        }
        pre.appendChild(code);
        preview.appendChild(pre);
    }
    if (fetched.truncated) {
        const note = document.createElement("div");
        note.className = "aiball-attachment__truncated";
        note.textContent = `(preview truncated at ${PREVIEW_LINE_CAP} lines / ${PREVIEW_BYTE_CAP / 1024} KB — download for full)`;
        preview.appendChild(note);
    }
}

/**
 * Walk `root` for `<a href="/uploads/…">` links and replace each with
 * an AttachmentCard (DL-only or with collapsible preview, by ext).
 * Idempotent — already-processed links carry `data-aiball-att="1"`.
 */
export function wireAttachmentCards(
    root: HTMLElement,
    opts: { renderMarkdown: (md: string) => string },
): void {
    const links = root.querySelectorAll<HTMLAnchorElement>(`a[href^="${UPLOAD_PREFIX}"]`);
    for (const link of links) {
        if (link.dataset.aiballAtt === "1") continue;
        link.dataset.aiballAtt = "1";
        const href = link.getAttribute("href") ?? "";
        const ext = extOf(href);
        if (!ext) continue;
        const cls = classify(ext);
        if (cls.kind === "image") continue; // <img> already rendered by marked

        const card = buildCard(link, cls, opts.renderMarkdown);
        // Standalone link in its own <p> → swap the <p>. Inline → swap
        // the <a> directly. The card uses block layout either way; in
        // inline context it still reads as a clearly delimited card.
        const parent = link.parentElement;
        const standalone = parent
            && parent.tagName === "P"
            && parent.childElementCount === 1
            && (parent.firstChild === link)
            && (parent.textContent ?? "").trim() === (link.textContent ?? "").trim();
        if (standalone && parent?.parentElement) {
            parent.parentElement.replaceChild(card, parent);
        } else {
            link.replaceWith(card);
        }
    }
}
