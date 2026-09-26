/**
 * #3063 — parameter shapes shared by the bus methods. A method's params are
 * JSON on the bus; the HTTP route that serves it while clients move over maps
 * its path, query and body into the same object, so the shapes below also
 * accept what a query string carries ("1", "42").
 */
import { z } from "zod";

/** A yes/no flag: true / false, or a query's "1" / "0" / "true" / "false". */
export const flag = z.preprocess(
    (v) => (v === "1" || v === "true" ? true : v === "0" || v === "false" || v === "" ? false : v),
    z.boolean(),
).optional();

/** A positive integer id: a number, or its digits in a path or a query. */
export const id = z.coerce.number().int().positive();

/** An optional non-empty string; an empty one reads as absent. */
export const text = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());
