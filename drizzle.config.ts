import type { Config } from "drizzle-kit";
import { homedir } from "node:os";
import { join } from "node:path";

const dbFile = process.env.AIBALL_HOME
    ? join(process.env.AIBALL_HOME, "aiball.db")
    : join(homedir(), ".local", "share", "aiball", "aiball.db");

export default {
    schema: "./src/schema.ts",
    out: "./drizzle/migrations",
    dialect: "sqlite",
    dbCredentials: { url: dbFile },
} satisfies Config;
