/**
 * #3969 — the zone the UI shows times in. Unset (the board's `display.timezone`
 * is `auto`): the browser's. Set: that zone, whatever the browser says — the
 * same one agents read and write in.
 */
import { ref } from "vue";

export const displayTimeZone = ref<string | undefined>(undefined);

const zoned = (o: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormatOptions =>
    displayTimeZone.value ? { ...o, timeZone: displayTimeZone.value } : o;

/** Date and time, in the display zone. */
export function fmtDateTime(v: string | number | Date): string {
    return new Date(v).toLocaleString(undefined, zoned());
}

/** The date alone, in the display zone. */
export function fmtDate(v: string | number | Date, o?: Intl.DateTimeFormatOptions): string {
    return new Date(v).toLocaleDateString(undefined, zoned(o));
}

/** The time alone, in the display zone. */
export function fmtTime(v: string | number | Date, o?: Intl.DateTimeFormatOptions): string {
    return new Date(v).toLocaleTimeString(undefined, zoned(o));
}

/** The calendar day in the display zone, to compare two times. */
export function dayKey(v: string | number | Date): string {
    return new Date(v).toLocaleDateString("en-CA", zoned());
}
