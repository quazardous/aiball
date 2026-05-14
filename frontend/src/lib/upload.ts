/**
 * Image upload helper (per #B.76). Sends the file bytes directly to
 * `POST /api/uploads` with the right content-type — no multipart
 * wrapper, the backend reads `req.body` as a Buffer. Returns the
 * absolute path (e.g. `/uploads/<sha>.png`) that should be embedded
 * in a markdown `![]()` reference.
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

const ALLOWED_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
]);

export function isUploadableImage(file: File | Blob): boolean {
    return ALLOWED_TYPES.has(file.type);
}

export async function uploadImage(file: File | Blob): Promise<UploadResult> {
    if (!isUploadableImage(file)) {
        throw new Error(
            `unsupported image type "${file.type}" — allowed: ${[...ALLOWED_TYPES].join(", ")}`,
        );
    }
    const headers: Record<string, string> = {
        "content-type": file.type,
        "x-aiball-consumer":
            localStorage.getItem("aiball.human_id") ?? "human",
    };
    // #B.94: image uploads also live behind the bearer-auth middleware.
    const tok = localStorage.getItem("aiball.token");
    if (tok) headers["authorization"] = `Bearer ${tok}`;
    const res = await fetch("/api/uploads", {
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
