/**
 * Frontend mirror of `src/questions.ts` (#B.104). String-pure
 * helpers to read question markers out of a markdown body. The
 * backend owns marker injection and toggle persistence; the frontend
 * only needs to extract questions so it can:
 *
 *   - render the chip "X/Y open" on a comment card
 *   - know which question id was clicked (by index in the body) so
 *     the composer can quote it and the answer endpoint can toggle it
 *
 * Kept separate from the backend module because the frontend bundle
 * doesn't pull from `src/` (different tsconfig + no node imports).
 * Logic is intentionally identical to keep the two halves in sync.
 */

export type QuestionStatus = "open" | "answered";

export interface Question {
    id: string;
    text: string;
    status: QuestionStatus;
    /** Zero-based ordinal among task-list items in the body. */
    index: number;
}

// `- [ ]` or `- [x]` (or `*` / `+` bullet, indented or not), optional
// `<!-- q:xxx -->` marker right after the close-bracket, optional
// trailing text. Captures: 1=indent, 2=char, 3=marker-id, 4=text.
const TASK_LINE = /^([ \t]*)(?:[-*+])\s\[( |x|X)\](?:<!--\s*q:([a-zA-Z0-9_-]+)\s*-->)?(.*)$/;

export function extractQuestions(body: string | null | undefined): Question[] {
    if (!body) return [];
    const out: Question[] = [];
    const lines = body.split("\n");
    let index = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = TASK_LINE.exec(lines[i]);
        if (!m) continue;
        const char = m[2].toLowerCase();
        const id = m[3] ?? `__unmarked_${index}__`;
        const text = (m[4] ?? "").trim();
        out.push({
            id,
            text,
            status: char === "x" ? "answered" : "open",
            index,
        });
        index++;
    }
    return out;
}

export function questionStats(body: string | null | undefined): {
    total: number;
    answered: number;
    open: number;
} {
    const qs = extractQuestions(body);
    const answered = qs.filter((q) => q.status === "answered").length;
    return { total: qs.length, answered, open: qs.length - answered };
}
