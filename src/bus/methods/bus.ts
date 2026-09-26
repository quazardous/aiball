/** #3063 — the bus's own methods. */
import { z } from "zod";
import { defineMethod } from "../methods.js";

/** Who the connection runs as: what every call on it is authorized against. */
export const whoami = defineMethod({
    name: "bus.whoami",
    who: ["human", "agent"],
    params: z.object({}).strict(),
    run: (caller) => ({ consumer: caller.consumer_id ?? null, kind: caller.kind, relayed: caller.relayed, transport: caller.transport }),
});
