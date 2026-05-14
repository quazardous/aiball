/**
 * `components` CLI — read-only inventory + version extractors driven
 * by a project-root `components.yaml` (#B.96).
 *
 *   components list                          one row per component
 *   components version <key>                 print one version
 *   components versions                      JSON map {key: version}
 *   components changelog <key> [--limit N]   tail CHANGELOG entries
 *
 * Pass --config <path> to point at an explicit components.yaml;
 * otherwise we walk up from cwd.
 */
import { Command } from "commander";
import { loadConfig, findComponent, type ComponentsConfig } from "./parser.js";
import { extractVersion } from "./extractors/index.js";
import { tailChangelog } from "./changelog.js";

interface GlobalOpts {
    config?: string;
}

function loadCfgOrDie(opts: GlobalOpts): ComponentsConfig {
    try {
        return loadConfig(opts.config ?? null);
    } catch (e) {
        process.stderr.write(`components: ${(e as Error).message}\n`);
        process.exit(1);
    }
}

const program = new Command();
program
    .name("components")
    .description("Read-only component inventory + version extractors")
    .option("--config <path>", "Path to components.yaml (default: walk up from cwd)")
    .version("0.1.0");

program
    .command("list")
    .description("List all components (key, name, file, extractor)")
    .action(() => {
        const cfg = loadCfgOrDie(program.opts<GlobalOpts>());
        for (const c of cfg.components) {
            const flag = c.main ? " *" : "  ";
            const name = c.name ?? "";
            const where = c.file ?? `[${c.extractor}]`;
            process.stdout.write(`${flag} ${c.key.padEnd(20)} ${name.padEnd(24)} ${where}\n`);
        }
    });

program
    .command("version <key>")
    .description("Print one component's version")
    .action((key: string) => {
        const cfg = loadCfgOrDie(program.opts<GlobalOpts>());
        try {
            const c = findComponent(cfg, key);
            process.stdout.write(extractVersion(cfg, c) + "\n");
        } catch (e) {
            process.stderr.write(`components: ${(e as Error).message}\n`);
            process.exit(1);
        }
    });

program
    .command("versions")
    .description("Print every component's version as a JSON map")
    .option("--pretty", "Pretty-print the JSON")
    .action((opts: { pretty?: boolean }) => {
        const cfg = loadCfgOrDie(program.opts<GlobalOpts>());
        const out: Record<string, string | { error: string }> = {};
        for (const c of cfg.components) {
            try {
                out[c.key] = extractVersion(cfg, c);
            } catch (e) {
                out[c.key] = { error: (e as Error).message };
            }
        }
        process.stdout.write(JSON.stringify(out, null, opts.pretty ? 2 : 0) + "\n");
    });

program
    .command("changelog <key>")
    .description("Tail a component's CHANGELOG (requires `changelog:` in components.yaml)")
    .option("--limit <n>", "How many entries to return", "5")
    .action((key: string, opts: { limit: string }) => {
        const cfg = loadCfgOrDie(program.opts<GlobalOpts>());
        try {
            const c = findComponent(cfg, key);
            const limit = Number.parseInt(opts.limit, 10);
            if (!Number.isFinite(limit) || limit <= 0) {
                process.stderr.write(`components: --limit must be a positive integer\n`);
                process.exit(1);
            }
            const entries = tailChangelog(cfg, c, limit);
            for (const e of entries) {
                process.stdout.write(`${e.header}\n${e.body}\n\n`);
            }
        } catch (e) {
            process.stderr.write(`components: ${(e as Error).message}\n`);
            process.exit(1);
        }
    });

program.parse(process.argv);
