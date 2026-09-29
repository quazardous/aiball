/**
 * #3283 — the model a Claude runs, as a person names it: `claude-opus-5-5` is
 * "Opus 5.5". Read from the id alone, without the network, so a model released
 * after this code still gets a name: the family words, then the version numbers
 * joined by dots; a release date (`-20251001`) is dropped, a context tag
 * (`[1m]`) kept. An id this reading does not recognise stays as it is.
 */
export function modelShortName(id: string): string {
    const tag = /\[([^\]]+)\]$/.exec(id)?.[1];
    const base = id.replace(/\[[^\]]+\]$/, "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
    const parts = base.split("-").filter(Boolean);
    const words = parts.filter((p) => /^[a-z]+$/i.test(p));
    const numbers = parts.filter((p) => /^\d+$/.test(p));
    if (words.length === 0 || words.length + numbers.length !== parts.length) return id;
    const name = [words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" "), numbers.join(".")].filter(Boolean).join(" ");
    return tag ? `${name} (${tag.toUpperCase()})` : name;
}
