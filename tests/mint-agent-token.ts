// #981 Slice 1 — mint a NODE token into the daemon DB for the full-stack
// container agent. Bootstrap-only helper : run with AIBALL_HOME pointed at the
// (shared) daemon DB volume, prints the bearer token to stdout. The loop then
// authenticates over HTTP (AIBALL_URL) with this node token + an asserted
// `--consumer` identity (REMOTE.md Type 1 "Proxy/node" model) and never touches
// the DB again.
//
// Why node (not agent) : an agent token FKs to an existing consumer row, which
// doesn't exist on a fresh ephemeral DB ; a node token has consumer_id NULL (no
// FK) and the loop asserts its identity via --consumer. Switch to agent-token
// here if/when the seed step creates the consumer first (stricter identity).
//
// Usage: AIBALL_HOME=/data npx tsx tests/mint-agent-token.ts [label]
import { issueToken } from "../src/db/tokens.js";

const label = process.argv[2] ?? "fullstack-node";
process.stdout.write(issueToken({ kind: "node", label }).token);
