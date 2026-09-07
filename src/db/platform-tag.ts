/**
 * #2099 — the platform tag a ticket gets when an agent files it.
 *
 * david: « selon la plateforme un tag automatique doit être ajouté lors de la
 * création d'un ticket par un agent — genre os:linux os:win ».
 *
 * ## Why the client has to say it
 *
 * The daemon cannot work it out. An agent behind a proxy node arrives carrying
 * the NODE's address, not its own machine — `classy` relays eleven consumers,
 * and inferring from the connection would stamp every one of them Windows.
 * Only the process that created the ticket knows what it runs on, so it says
 * so in a header, next to the ones it already sends about itself
 * (`x-aiball-role`, `x-aiball-no-claim`).
 *
 * ## Why a closed set
 *
 * A tag that does not exist makes ticket creation fail, so an automatic tag
 * has to be created on the fly — and the catalogue is otherwise curated by a
 * human. What keeps that safe is that the mapping below is TOTAL and SERVER
 * SIDE: a client cannot name a tag, it can only pick one of three. Anything
 * else, including a plausible-looking `os:freebsd`, maps to nothing and no tag
 * is applied. The blast radius of a lying client is therefore "one of three
 * tags I already accept", not "an arbitrary row in the catalogue".
 */

/** The prefix this feature owns. Nothing outside it is ever created here. */
export const PLATFORM_TAG_PREFIX = "os:";

/**
 * Node's `process.platform` → the tag name, or null when we don't have a name
 * for it. Deliberately not exhaustive over Node's platform union: the three
 * aiball actually runs on are the three that get a tag, and an unknown one
 * silently gets none rather than inventing `os:sunos`.
 *
 * Accepts the raw header, so a client that sends `win32` (Node's spelling) and
 * one that sends `win` (aiball's, used in the tag catalogue) both land on the
 * same tag. That difference is exactly the kind of thing that would otherwise
 * produce two near-identical tags nobody meant to create.
 */
export function platformTagName(raw: string | null | undefined): string | null {
    const v = (raw ?? "").trim().toLowerCase();
    switch (v) {
        case "linux":
            return "os:linux";
        case "win":
        case "win32":
        case "windows":
            return "os:win";
        case "mac":
        case "darwin":
        case "macos":
            return "os:mac";
        default:
            return null;
    }
}
