/**
 * #990 S3 — CLI front for the boot replay. Reads a CL_CAPTURE dir's pane
 * timeline and reports whether the recorded boot phase sealed (and if not,
 * which module is stuck). Used to turn a real recorded session into a
 * deterministic verdict without tmux/claude.
 *
 * Usage: cl-replay-boot <capture-dir> [--json] [--boot-min-sec N]
 */
import { replayBootFromCapture } from "./boot-replay.js";

function main(argv: string[]): void {
    const args = argv.slice(2);
    const dir = args.find((a) => !a.startsWith("--"));
    if (!dir) {
        process.stderr.write("usage: cl-replay-boot <capture-dir> [--json] [--boot-min-sec N]\n");
        process.exit(2);
    }
    const json = args.includes("--json");
    const minIdx = args.indexOf("--boot-min-sec");
    const bootMinMs = minIdx >= 0 ? Number(args[minIdx + 1]) * 1000 : undefined;

    const r = replayBootFromCapture(dir, bootMinMs ? { bootMinMs } : {});
    if (json) {
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
        process.exit(r.sealed ? 0 : 1);
    }
    const verdict = r.sealed
        ? `SEALED at +${((r.sealedAtRelMs ?? 0) / 1000).toFixed(1)}s (${r.sealReason})`
        : `NEVER SEALED — stuck on [${r.finalActiveModules.join(", ") || "?"}]`;
    process.stdout.write(`boot replay: ${r.paneFrameCount} pane frames → ${verdict}\n`);
    if (r.moduleEdges.length) {
        process.stdout.write("modules:\n");
        for (const e of r.moduleEdges) {
            process.stdout.write(`  +${(e.relMs / 1000).toFixed(1).padStart(6)}s  ${e.edge === "start" ? "▶ start" : "■ end  "}  ${e.name}\n`);
        }
    }
    process.exit(r.sealed ? 0 : 1);
}

main(process.argv);
