/**
 * Image-upload MCP tool (#387). Lets an agent attach an image to a ticket /
 * comment WITHOUT touching the HTTP/TCP port: it reads a local file and POSTs
 * the bytes to /api/uploads over the SAME transport as every other MCP call
 * (the Unix socket, local-trust, token-less). Returns the content-addressable
 * `/uploads/<sha>.<ext>` ref plus a ready-to-paste markdown snippet to drop
 * into a `ticket_new` / `ticket_reply` body — where images render in the UI.
 *
 * Why a tool and not just "reference a path in the body": the daemon stores
 * uploads content-addressable under `$AIBALL_HOME/uploads`, and a body can only
 * reference an already-stored sha. This tool does the missing "store" half.
 *
 * Exposed entry point: `registerUploadTools(server)`.
 */
import { basename } from "node:path";
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { asText, client } from "./_helpers.js";

/** File extension → image mime the daemon accepts (mirrors src/api/uploads.ts #B.76). */
const EXT_TO_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
};

export function registerUploadTools(server: McpServer): void {
    server.registerTool(
        "upload",
        {
            description:
                "Upload a local image file so it can be embedded in a ticket/comment body. Reads the file at `path` and POSTs its bytes to the daemon's content-addressable store (`/api/uploads`) over the SAME transport as every other MCP call — the local Unix socket, token-less. Returns `{ url, sha256, bytes, content_type, markdown }`: drop `markdown` (an `![](…)` snippet) straight into a `ticket_new` / `ticket_reply` body and the image renders in the web UI. Supported types: png, jpeg, gif, webp (size cap configurable, default 10 MB). Uploads dedupe by sha, so re-uploading the same bytes is cheap and stable. NOTE: the MCP runs on this host, so the only image you can attach is one already on this host's filesystem — point `path` at it.",
            inputSchema: {
                path: z
                    .string()
                    .describe("Path (absolute, or relative to the MCP cwd) to a local image file: png / jpeg / gif / webp."),
                name: z
                    .string()
                    .optional()
                    .describe("Optional original filename recorded as metadata + used as the markdown alt text. Defaults to the file's basename."),
            },
        },
        async ({ path, name }) => {
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            const mime = EXT_TO_MIME[ext];
            if (!mime) {
                throw new Error(
                    `unsupported image type ".${ext}" — allowed: ${Object.keys(EXT_TO_MIME).join(", ")}`,
                );
            }
            let bytes: Buffer;
            try {
                bytes = readFileSync(path);
            } catch (e) {
                throw new Error(`cannot read "${path}": ${(e as Error).message}`);
            }
            const alt = name ?? basename(path);
            const res = await client.uploadImage(bytes, mime, alt);
            return asText({ ...res, markdown: `![${alt}](${res.url})` });
        },
    );
}
