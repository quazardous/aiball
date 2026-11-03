/**
 * #4701 — what kind of value a setting takes, in one vocabulary for every
 * surface that describes settings (`config.managed`, `project.settings`): a
 * client picks its input from `shape` without knowing the key. The fields each
 * surface had before (`type`, `min`, `options`…) stay beside it.
 */

export type ValueShape =
    /** `integer`: whole numbers only; the bounds are inclusive. */
    | { type: "number"; integer: boolean; min?: number; max?: number; step?: number; unit?: string }
    /** In seconds on the wire. */
    | { type: "duration"; min?: number; max?: number; step?: number }
    | { type: "enum"; options: readonly string[] }
    | { type: "boolean" }
    /** true, false or a name. */
    | { type: "boolean_or_name" }
    /** `hint`: what a refused value should have been. */
    | { type: "string"; multiline: boolean; hint?: string }
    /** `must_exist`: a path that is not there is refused. */
    | { type: "path"; kind: "dir" | "file"; must_exist: boolean }
    /** `schemes`: the ones accepted, `https` say. */
    | { type: "url"; schemes: readonly string[] };

const defined = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A `config.managed` key's shape, from its schema entry. A number is whole unless its step, a bound or its default is not. */
export function shapeOfConfigEntry(e: {
    type: string; options?: readonly string[]; min?: number; max?: number; step?: number; unit?: string;
    default: unknown; multiline?: boolean; validateHint?: string;
}): ValueShape {
    switch (e.type) {
        case "number": {
            const whole = [e.step, e.min, e.max, typeof e.default === "number" ? e.default : undefined]
                .every((n) => n === undefined || Number.isInteger(n));
            return defined({ type: "number" as const, integer: whole, min: e.min, max: e.max, step: e.step, unit: e.unit });
        }
        case "duration":
            return defined({ type: "duration" as const, min: e.min, max: e.max, step: e.step });
        case "enum":
            return { type: "enum", options: e.options ?? [] };
        case "boolean":
            return { type: "boolean" };
        default:
            return defined({ type: "string" as const, multiline: e.multiline === true, hint: e.validateHint });
    }
}
