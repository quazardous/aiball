/**
 * Demo seed — fill a THROWAWAY aiball instance with lorem-ipsum data for
 * screenshots / demos (landing page, DevHunt, …). NEVER touches the live
 * data dir: it hard-refuses when AIBALL_HOME resolves to the real one.
 *
 * It sideloads an `admin` / `admin` human straight into the DB (bypassing the
 * install-token → /setup securing flow — that step exists for real installs,
 * not for a disposable demo box), seeds a handful of agent consumers with
 * live-looking states, a few projects, and a board of lorem-ipsum tickets
 * (varied intent / priority, threaded comments, pending decisions, a couple
 * closed / resolved).
 *
 * Idempotent: it wipes the demo tables first, so re-running gives a clean board.
 *
 * Usage (local):
 *   AIBALL_HOME=/tmp/aiball-demo npx tsx scripts/demo-seed.ts
 *   AIBALL_SOCK="" AIBALL_HOME=/tmp/aiball-demo AIBALL_PORT=7776 npm start
 *   # open http://127.0.0.1:7776/  →  log in  admin / admin
 *
 * ⚠️ Always launch the demo daemon with AIBALL_SOCK="" — it disables the
 * local-trust UDS. The demo is reached over HTTP only, and a stray UDS would
 * risk colliding with a real aiball daemon's local-trust socket on the same box.
 *
 * The Dockerfile runs this as its entrypoint's first step.
 */
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";

// --- safety guard: never seed the live data dir ---------------------------
const LIVE_HOME = resolve(join(homedir(), ".local", "share", "aiball"));
if (!process.env.AIBALL_HOME) process.env.AIBALL_HOME = join(tmpdir(), "aiball-demo");
if (resolve(process.env.AIBALL_HOME) === LIVE_HOME) {
    console.error(
        `refuse: AIBALL_HOME (${process.env.AIBALL_HOME}) is the LIVE aiball data dir.\n` +
            "Point it at a throwaway directory before seeding demo data.",
    );
    process.exit(1);
}

// Import db modules AFTER AIBALL_HOME is pinned — paths.ts reads it at load.
const { getDb, nowIso } = await import("../src/db/connection.js");
const schema = await import("../src/schema.js");
const { createProject } = await import("../src/db/projects.js");
const { insertMessage } = await import("../src/db/messages.js");
const { upsertConsumer, setPasswordHash, setConsumerState } = await import("../src/db/consumers.js");
const { hashPassword } = await import("../src/auth.js");

const db = getDb(); // opens the DB + runs migrations

// --- wipe (idempotent re-run) ---------------------------------------------
db.delete(schema.pings).run();
db.delete(schema.messages).run();
db.delete(schema.tickets).run();
db.delete(schema.projects).run();
db.delete(schema.consumers).run();

const H = 3_600_000;
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * H).toISOString();

// --- admin (sideloaded, admin / admin) ------------------------------------
upsertConsumer({ consumer_id: "admin", kind: "human", display_name: "Admin", enabled: true });
setPasswordHash("admin", await hashPassword("admin"));

// --- agent consumers with live-looking states -----------------------------
const AGENTS: Array<{
    id: string;
    state: "boot" | "idle" | "busy";
    word: "stop" | "wait" | "boot" | "loop";
    project: string;
}> = [
    { id: "r2d2-astromech", state: "busy", word: "loop", project: "death-star" },
    { id: "c3po-protocol", state: "idle", word: "wait", project: "death-star" },
    { id: "recon-probe", state: "idle", word: "stop", project: "star-destroyer" },
    { id: "mouse-droid", state: "boot", word: "boot", project: "tie-fighter" },
];
for (const a of AGENTS) {
    upsertConsumer({ consumer_id: a.id, kind: "agent", display_name: a.id, enabled: true });
    setConsumerState(a.id, a.state, false, a.word, `/home/empire/${a.project}`, a.project);
}

// --- projects --------------------------------------------------------------
createProject({ name: "death-star", display_name: "death-star", description: "DS-1 Orbital Battle Station — construction & superlaser bring-up.", created_by: "admin" });
createProject({ name: "star-destroyer", display_name: "star-destroyer", description: "Imperial-class Star Destroyer fleet ops.", created_by: "admin" });
createProject({ name: "tie-fighter", display_name: "tie-fighter", description: "TIE/LN starfighter production line.", created_by: "admin" });

// --- themed placeholder pool: "building the Death Star" --------------------
const TITLES = [
    "Superlaser focusing array is misaligned by 0.3°",
    "Thermal exhaust port on the meridian is only 2m wide",
    "Reactor core containment field spec sign-off",
    "Recruit 40k more stormtroopers for sector 7",
    "Trash compactor 3263827 — organism infestation",
    "Tractor beam power coupling keeps tripping",
    "Docking bay 327 traffic control overload",
    "Detention block AA-23 access-log audit",
    "Hyperdrive motivator vibration at sublight",
    "Turbolaser tower gunners night-shift rota",
    "Command bridge viewport glare on the dark side",
    "Shield generator gap during construction phase",
];
const BODY =
    "Per the Imperial construction schedule, this needs sign-off before the station reaches the Alderaan system. Coordinate with the engineering corps and report blockers to the overseeing officer. The Emperor is not to be kept waiting.";
const SUMMARY = "Awaiting engineering-corps confirmation before the next construction milestone.";

type Spec = {
    title: string;
    project?: string;
    intent: "panic" | "request" | "question" | "fyi" | "feature";
    priority: "low" | "normal" | "high" | "urgent";
    by: string;
    ageH: number;
    comments?: Array<{ by: string; decision?: "plan" | "resolution" | "escalation"; ageH: number }>;
    close?: "closed" | "resolved";
};

const SPECS: Spec[] = [
    { title: TITLES[0], intent: "feature", priority: "high", by: "r2d2-astromech", ageH: 3, comments: [{ by: "admin", ageH: 2 }, { by: "r2d2-astromech", decision: "plan", ageH: 1 }] },
    { title: TITLES[1], intent: "request", priority: "urgent", by: "admin", ageH: 6, comments: [{ by: "c3po-protocol", decision: "resolution", ageH: 1 }] },
    { title: TITLES[2], intent: "question", priority: "normal", by: "c3po-protocol", ageH: 9 },
    { title: TITLES[3], intent: "request", priority: "normal", by: "admin", ageH: 20, comments: [{ by: "r2d2-astromech", ageH: 18 }, { by: "admin", ageH: 4 }] },
    { title: TITLES[4], intent: "fyi", priority: "low", by: "recon-probe", ageH: 26 },
    { title: TITLES[5], intent: "feature", priority: "high", by: "r2d2-astromech", ageH: 30, comments: [{ by: "r2d2-astromech", decision: "escalation", ageH: 5 }] },
    { title: TITLES[6], intent: "request", priority: "normal", by: "admin", ageH: 48, close: "resolved", comments: [{ by: "c3po-protocol", ageH: 40 }] },
    { title: TITLES[7], intent: "question", priority: "low", by: "c3po-protocol", ageH: 60 },
    { title: TITLES[8], intent: "request", priority: "normal", by: "admin", ageH: 72, close: "closed" },
    { title: TITLES[9], intent: "feature", priority: "normal", by: "r2d2-astromech", ageH: 96, comments: [{ by: "admin", ageH: 80 }] },
    { title: TITLES[10], project: "star-destroyer", intent: "request", priority: "high", by: "recon-probe", ageH: 12 },
    { title: TITLES[11], project: "tie-fighter", intent: "question", priority: "normal", by: "mouse-droid", ageH: 15 },
];

function backdateTicket(id: number, createdAt: string) {
    db.update(schema.tickets).set({ createdAt, lastActorAt: createdAt }).where(eq(schema.tickets.id, id)).run();
}
function backdateMessage(id: number, createdAt: string) {
    db.update(schema.messages).set({ createdAt }).where(eq(schema.messages.id, id)).run();
}

for (const s of SPECS) {
    const project = s.project ?? "aiball";
    const t = insertMessage({
        kind: "ticket_created",
        project,
        title: s.title,
        body: BODY,
        summary: SUMMARY,
        by_agent: s.by,
        intent: s.intent,
        priority: s.priority,
    });
    backdateTicket(t.id, iso(s.ageH));

    for (const c of s.comments ?? []) {
        const m = insertMessage({
            kind: "comment_added",
            ticket_id: t.id,
            project,
            body: BODY,
            by_agent: c.by,
            summary_until: SUMMARY,
            decision_kind: c.decision,
        });
        backdateMessage(m.id, iso(c.ageH));
    }

    if (s.close) {
        const kind = s.close === "resolved" ? "ticket_resolved" : "ticket_closed";
        const m = insertMessage({ kind, ticket_id: t.id, project, by_agent: "admin" });
        backdateMessage(m.id, iso(Math.max(0, s.ageH - 2)));
    }
}

// --- approve everything (seeded rows default to moderation `pending`) ------
// Moderation status only — decision status lives in `meta.decision` and stays
// pending, so the accept/reject decision UI still shows on the board.
const approvedAt = nowIso();
db.update(schema.tickets).set({ status: "approved" }).run();
db.update(schema.messages).set({ status: "approved", decidedAt: approvedAt, decidedBy: "auto" }).run();

const ticketCount = db.select().from(schema.tickets).all().length;
console.log(`seeded ${ticketCount} tickets into ${process.env.AIBALL_HOME}`);
console.log("login: admin / admin");
console.log(`start: AIBALL_HOME=${process.env.AIBALL_HOME} AIBALL_PORT=${process.env.AIBALL_PORT ?? 7776} npm start`);
