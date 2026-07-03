/**
 * File upload helper (per #B.76, generalised #694 to non-image types).
 * Sends the file bytes directly to `POST /api/uploads` with the right
 * content-type — no multipart wrapper, the backend reads `req.body` as
 * a Buffer. Returns the absolute path (e.g. `/uploads/<sha>.png`) that
 * should be embedded in a markdown reference. The caller picks the
 * snippet shape based on the returned `content_type` (image → `![](…)`,
 * text/code → `[name](…)`, binary → `📎 [download name](…)`).
 *
 * Throws on:
 *   - unsupported MIME type (HTTP 400).
 *   - body exceeds the configured `upload_max_bytes` (HTTP 413).
 *   - any network / server failure.
 *
 * The caller is responsible for catching and surfacing the error
 * (toast, inline message, etc.) — this module doesn't have UI access.
 */

export interface UploadResult {
    url: string;
    sha256: string;
    bytes: number;
    content_type: string;
}

/**
 * Mirrors the server allow-list in `src/api/uploads.ts:UPLOAD_MIME_TO_EXT`.
 * Browsers don't always populate `file.type` for less-common MIMEs
 * (e.g. `.toml` is often "" or "application/octet-stream"), so the
 * picker also falls back to extension sniffing via `extToMime` below
 * and the server still has the final say via its allow-list.
 */
import { withBase } from "./base";

const ALLOWED_TYPES = new Set([
    // Images
    "image/png", "image/jpeg", "image/gif", "image/webp",
    // Text / source-readable. `text/html` deliberately excluded (XSS).
    "text/plain", "text/markdown", "text/csv", "text/yaml",
    "text/x-python", "text/x-typescript", "text/javascript",
    "text/x-c", "text/x-c++", "text/x-shellscript",
    "text/x-diff", "text/x-patch",
    // Application — structured + opaques. Executables excluded.
    "application/json", "application/x-yaml", "application/x-toml",
    "application/x-shellscript", "application/x-patch",
    "application/x-tar", "application/gzip", "application/zip",
    "application/pdf", "application/octet-stream",
]);

const EXT_TO_MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp",
    txt: "text/plain", md: "text/markdown", log: "text/plain",
    csv: "text/csv", yaml: "application/x-yaml", yml: "application/x-yaml",
    toml: "application/x-toml", json: "application/json",
    sh: "application/x-shellscript", bash: "application/x-shellscript",
    py: "text/x-python", ts: "text/x-typescript", tsx: "text/x-typescript",
    js: "text/javascript", jsx: "text/javascript",
    c: "text/x-c", cpp: "text/x-c++", h: "text/x-c", hpp: "text/x-c++",
    diff: "text/x-diff", patch: "text/x-patch",
    tar: "application/x-tar", gz: "application/gzip", tgz: "application/gzip",
    zip: "application/zip", pdf: "application/pdf", bin: "application/octet-stream",
};

/** Server allow-list mirror — `accept=` value for `<input type=file>`. */
export const UPLOAD_ACCEPT = [
    "image/png", "image/jpeg", "image/gif", "image/webp",
    ".txt", ".md", ".log", ".csv",
    ".json", ".yaml", ".yml", ".toml",
    ".sh", ".bash", ".py", ".ts", ".tsx", ".js", ".jsx",
    ".c", ".cpp", ".h", ".hpp", ".diff", ".patch",
    ".tar", ".gz", ".tgz", ".zip", ".pdf",
].join(",");

function resolveMime(file: File | Blob): string {
    if (file.type && ALLOWED_TYPES.has(file.type)) return file.type;
    const name = (file as File).name ?? "";
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const fromExt = EXT_TO_MIME[ext];
    if (fromExt) return fromExt;
    return file.type || "application/octet-stream";
}

/**
 * Pick the markdown snippet the recipient sees in the rendered body,
 * mirroring `src/mcp/upload.ts:renderMarkdown` :
 *   - image/* → inline `![alt](url)`
 *   - text/* + structured code → `[name](url)`
 *   - everything else (archives, pdf, octet-stream) → `📎 [name](url)`
 */
export function renderUploadSnippet(name: string, url: string, contentType: string): string {
    if (contentType.startsWith("image/")) return `![${name}](${url})`;
    if (contentType.startsWith("text/")) return `[${name}](${url})`;
    const isCode = contentType === "application/json"
        || contentType === "application/x-yaml"
        || contentType === "application/x-toml"
        || contentType === "application/x-shellscript"
        || contentType === "application/x-patch";
    if (isCode) return `[${name}](${url})`;
    return `📎 [${name}](${url})`;
}

export async function uploadFile(file: File | Blob): Promise<UploadResult> {
    const mime = resolveMime(file);
    if (!ALLOWED_TYPES.has(mime)) {
        throw new Error(
            `unsupported type "${file.type || "(unknown)"}" — allowed: ${[...ALLOWED_TYPES].join(", ")}`,
        );
    }
    const headers: Record<string, string> = {
        "content-type": mime,
        "x-aiball-consumer":
            localStorage.getItem("aiball.human_id") ?? "human",
    };
    if ((file as File).name) {
        headers["x-aiball-upload-name"] = (file as File).name.slice(0, 200);
    }
    // #B.94: uploads also live behind the bearer-auth middleware.
    const tok = localStorage.getItem("aiball.token");
    if (tok) headers["authorization"] = `Bearer ${tok}`;
    const res = await fetch(withBase("/api/uploads"), {
        method: "POST",
        headers,
        body: file,
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        let detail = text;
        try {
            const parsed = JSON.parse(text);
            if (parsed?.error) detail = parsed.error;
        } catch {
            /* keep raw text */
        }
        throw new Error(`upload failed (${res.status}): ${detail}`);
    }
    return (await res.json()) as UploadResult;
}

/** Back-compat alias for the clipboard paste flow (pasteImage.ts) which
 *  is intentionally image-only — clipboard rarely carries non-image blobs. */
export function isUploadableImage(file: File | Blob): boolean {
    return file.type.startsWith("image/") && ALLOWED_TYPES.has(file.type);
}
export const uploadImage = uploadFile;
