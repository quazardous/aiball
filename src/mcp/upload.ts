/**
 * File-upload MCP tool. Lets an agent attach a file (image, text, code,
 * binary) to a ticket / comment WITHOUT touching the HTTP/TCP port : it
 * reads a local file and POSTs the bytes to /api/uploads over the SAME
 * transport as every other MCP call (the Unix socket, local-trust,
 * token-less). Returns the content-addressable `/uploads/<sha>.<ext>`
 * ref plus a ready-to-paste markdown snippet to drop into a `ticket_new`
 * / `ticket_reply` body — images render inline, text/code as a link, and
 * binaries as a download link.
 *
 * Originally image-only (#387). Generalised in #694 from pisynth-claude's
 * feedback (#692) — agents need to exchange code, configs, patches and
 * logs as artefacts, not pasted-and-double-escaped markdown.
 *
 * Why a tool and not just "reference a path in the body" : the daemon
 * stores uploads content-addressable under `$AIBALL_HOME/uploads`, and a
 * body can only reference an already-stored sha. This tool does the
 * missing "store" half.
 *
 * Exposed entry point : `registerUploadTools(server)`.
 */
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client } from "./_helpers.js";

/**
 * File extension → MIME type. Mirrors what `api/uploads.ts:UPLOAD_MIME_TO_EXT`
 * accepts (with multiple extensions per MIME on the read side). Unknown
 * extensions fall back to `application/octet-stream` so opaque blobs are still
 * uploadable as long as the server's allow-list permits the MIME.
 */
const EXT_TO_MIME: Record<string, string> = {
    // Images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    // Text / source-readable
    txt: "text/plain",
    md: "text/markdown",
    log: "text/plain",
    csv: "text/csv",
    py: "text/x-python",
    ts: "text/x-typescript",
    tsx: "text/x-typescript",
    js: "text/javascript",
    jsx: "text/javascript",
    c: "text/x-c",
    cpp: "text/x-c++",
    cc: "text/x-c++",
    h: "text/x-c",
    hpp: "text/x-c++",
    sh: "application/x-shellscript",
    bash: "application/x-shellscript",
    diff: "text/x-diff",
    patch: "text/x-patch",
    // Structured data
    json: "application/json",
    yaml: "application/x-yaml",
    yml: "application/x-yaml",
    toml: "application/x-toml",
    // Archives + binaries
    tar: "application/x-tar",
    gz: "application/gzip",
    tgz: "application/gzip",
    zip: "application/zip",
    pdf: "application/pdf",
    bin: "application/octet-stream",
};

/**
 * Pick the markdown variant the recipient sees in the rendered body :
 *   - image → inline `<img>` via `![alt](url)`
 *   - text / structured code → bare link `[name.ext](url)` (no XSS — marked
 *     emits an `<a>` and DOMPurify keeps it)
 *   - everything else (archives, pdf, octet-stream) → 📎 prefix to signal
 *     a binary that the user has to download manually.
 */
function renderMarkdown(mime: string, alt: string, url: string): string {
    if (mime.startsWith("image/")) return `![${alt}](${url})`;
    if (mime.startsWith("text/") || isCodeMime(mime)) return `[${alt}](${url})`;
    return `📎 [${alt}](${url})`;
}

function isCodeMime(mime: string): boolean {
    return mime === "application/json"
        || mime === "application/x-yaml"
        || mime === "application/x-toml"
        || mime === "application/x-shellscript"
        || mime === "application/x-patch";
}

export function registerUploadTools(server: McpServer): void {
    server.registerTool(
        "upload",
        {
            description:
                "Upload a local file (image, text, code, archive, binary) so it can be embedded in a ticket / comment body. Reads the file at `path` and POSTs its bytes to the daemon's content-addressable store (`/api/uploads`) over the same transport as every other MCP call — the local Unix socket, token-less. Returns `{ url, sha256, bytes, content_type, markdown }` : drop `markdown` straight into a `ticket_new` / `ticket_reply` body. Images render inline (`![](…)`), text / code as a link (`[name.ext](…)`), other binaries as a `📎 [name.ext](…)` download link. Allow-list covers png/jpeg/gif/webp, text/markdown/csv/yaml, source code (py/ts/js/c/cpp/sh), structured data (json/yaml/toml), patches, archives (tar/gz/zip), pdf and octet-stream blobs. Deliberately excluded for security : svg, html, native executables. Uploads dedupe by sha — re-uploading the same bytes is cheap and stable. The MCP runs on this host, so the file must already be on this host's filesystem — point `path` at it. Size cap configurable (default 10 MB).",
            inputSchema: {
                path: z
                    .string()
                    .describe("Path (absolute, or relative to the MCP cwd) to the local file. Extension drives MIME detection ; unknown extensions are uploaded as application/octet-stream."),
                name: z
                    .string()
                    .optional()
                    .describe("Optional original filename recorded as metadata + used as the markdown link text / image alt. Defaults to the file's basename."),
            },
        },
        async ({ path, name }) => {
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            const mime = EXT_TO_MIME[ext] ?? "application/octet-stream";
            let bytes: Buffer;
            try {
                bytes = readFileSync(path);
            } catch (e) {
                throw new Error(`cannot read "${path}": ${(e as Error).message}`);
            }
            const alt = name ?? basename(path);
            const res = await client.uploadFile(bytes, mime, alt);
            return asText({ ...res, markdown: renderMarkdown(mime, alt, res.url) });
        },
    );
}
