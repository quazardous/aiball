/**
 * Rewrite the decision matrix in docs/TICKET_LIFECYCLE.md from the transition
 * table (src/ticket-transitions.ts). Run it after editing the table:
 *
 *   npx tsx scripts/gen-transition-matrix.ts           # rewrite the block
 *   npx tsx scripts/gen-transition-matrix.ts --check   # exit 1 when out of date
 *
 * A test fails while the doc and the table disagree, so forgetting to run it
 * is caught.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDecisionMatrix } from "../src/ticket-transitions.js";

const docPath = join(import.meta.dirname, "..", "docs", "TICKET_LIFECYCLE.md");
const doc = readFileSync(docPath, "utf8");
const next = withDecisionMatrix(doc);

if (process.argv.includes("--check")) {
    if (next !== doc) {
        console.error("docs/TICKET_LIFECYCLE.md: the decision matrix is out of date — run without --check");
        process.exit(1);
    }
    console.log("decision matrix up to date");
} else if (next === doc) {
    console.log("decision matrix already up to date");
} else {
    writeFileSync(docPath, next);
    console.log("decision matrix rewritten in docs/TICKET_LIFECYCLE.md");
}
