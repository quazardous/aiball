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

/** The methods of this bus, as an OpenRPC document, generated from the code. */
defineMethod({
    name: "rpc.discover",
    who: ["human", "agent"],
    params: z.object({}),
    run: async () => (await import("../contract.js")).openRpcDocument(),
});

/** The subjects of this bus, as an AsyncAPI document, generated from the code. */
defineMethod({
    name: "bus.subjects",
    who: ["human", "agent"],
    params: z.object({}),
    run: async () => (await import("../contract.js")).asyncApiDocument(),
});
