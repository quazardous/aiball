<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";

export interface ProjectListItem {
    label: string;
    value: string | null;
    icon: string;
    pending: number;
    unread: number;
    open: number;
    resolved: number;
    snoozed: number;
    /** #393: a claude-loop with a known root runs in this project (local). */
    local?: boolean;
    /** #393 (3c): a claude-loop is currently running (rooted consumer fresh). */
    running?: boolean;
    /** #537 — ISO timestamp of the project's latest ticket activity. Used by
     *  the active/inactive split : un projet avec des counters mais dont la
     *  dernière activité est très vieille est dormant, pas actif (david
     *  `vr4mwj` : « inactif c'est aussi un projet dont le derniier ticket
     *  est tres vieux »). Absent (undefined) = treated as fresh (back-compat). */
    last_activity?: string | null;
}

// #506 — `rules` + `work-filters` retirés (panels legacy supprimés, leur UI
// éditait des rows non consultées par le moteur depuis #483).
export type SettingsPanel = "general" | "automation" | "tags" | "projects" | "consumers" | "nodes" | "launchers" | "compose";

/**
 * Per-project sub-pages (#B.127): "settings" hosts the moderation
 * strategy + future admin; "stats" is read-only metrics. Entry points
 * live in Settings > Projects (ProjectsPanel rows) — sidebar receives
 * `projectPage` so the inbox item doesn't light up while a sub-page
 * is active.
 */
export type ProjectPage = "stats" | "settings" | "detail" | "overview";

const props = defineProps<{
    items: ProjectListItem[];
    panel: SettingsPanel | null;
    project: string | null;
    projectPage: ProjectPage | null;
}>();

const emit = defineEmits<{
    (e: "select", value: string | null): void;
    (e: "open-panel", panel: SettingsPanel): void;
    (e: "new-ticket"): void;
    (e: "open-current-settings"): void;
}>();

// #B.161: collapse the projects details by default on phones so the
// sidebar band (max-height 30vh on mobile) leaves room for the active
// project's badges + settings footer. User can still expand to pick
// another project. Tracked reactively to handle window resize.
const projectsOpen = ref(typeof window === "undefined" || window.innerWidth > 720);
function syncProjectsOpen() {
    projectsOpen.value = window.innerWidth > 720;
}
onMounted(() => window.addEventListener("resize", syncProjectsOpen));
onUnmounted(() => window.removeEventListener("resize", syncProjectsOpen));

// #B.161 follow-up: when the details is collapsed, the summary shows
// the active project so the user always knows where they are without
// expanding. Falls back to "Projects" when the list is empty.
const activeProjectLabel = computed(() => {
    const active = props.items.find((p) => p.value === props.project);
    return active?.label ?? "Projects";
});

// #537 david : split active / inactive — un projet est "actif" si une loop
// tourne dessus OU s'il a au moins un counter non-trivial (pending /
// unread / resolved) ET son dernier ticket est récent (≤14j, sinon les
// counters sont stales — david `vr4mwj` : « inactif c'est aussi un projet
// dont le derniier ticket est tres vieux »). `running` court-circuite : une
// loop qui tourne = actif définitionnellement, peu importe l'âge du dernier
// ticket. On garde le projet courant TOUJOURS visible même s'il est inactif
// (sinon il disparaît quand sélectionné). Même Sidebar.vue sert mobile/
// « version portable » via le `<details>` collapse #B.161 → le fix bénéficie
// aux deux viewports d'un seul changement.
const INACTIVE_AGE_DAYS = 14;
function isProjectActive(p: ProjectListItem): boolean {
    if (p.running) return true; // loop running = actif sans question
    const hasSignal = p.pending > 0 || p.unread > 0 || p.resolved > 0;
    if (!hasSignal) return false;
    // Recency check : si le dernier ticket est trop vieux, on dort.
    if (!p.last_activity) return true; // absent = back-compat, on assume fresh
    const ageMs = Date.now() - Date.parse(p.last_activity);
    if (Number.isNaN(ageMs)) return true; // ISO mal formé, on assume fresh
    return ageMs < INACTIVE_AGE_DAYS * 24 * 60 * 60 * 1000;
}
const allProjectItem = computed(() => props.items.find((p) => p.value === null) ?? null);
const activeProjects = computed(() =>
    props.items.filter((p) => p.value !== null && (isProjectActive(p) || p.value === props.project)),
);
const inactiveProjects = computed(() =>
    props.items.filter((p) => p.value !== null && !isProjectActive(p) && p.value !== props.project),
);
const inactiveOpen = ref(false);

// #B.161 desktop: clicking the project summary on desktop should NOT
// toggle the details (the projects list is always visible there;
// collapse only makes sense on mobile where vertical space is
// scarce). preventDefault stops the native <details> toggle.
function onProjectsSummaryClick(e: Event) {
    if (window.innerWidth > 720) e.preventDefault();
}

// #341: aiball version, injected at build time from the repo-root
// package.json (see vite.config.ts `define`). Falls back gracefully if
// the define is somehow absent (dev server without the constant).
const appVersion = typeof __AIBALL_VERSION__ === "string" ? __AIBALL_VERSION__ : "dev";
</script>

<template>
    <aside class="aiball-sidebar">
        <!-- #B.161: projects list wrapped in <details> so it collapses
             on mobile via CSS (open by default on desktop, collapsed
             by default on phone — saves the 30vh sidebar band for the
             active project's row only). -->
        <details class="sidebar-projects" :open="projectsOpen">
            <summary
                class="sidebar-section-label"
                @click="onProjectsSummaryClick"
            >
                <span class="sidebar-projects__label">{{ activeProjectLabel }}</span>
                <!-- #B.161 follow-up: quick "+ new ticket" on the
                     right of the project name when projects is
                     collapsed on mobile — saves the user from
                     scrolling past the inbox toolbar. Hidden on
                     desktop (the InboxToolbar already exposes it
                     there). @click.stop so the summary toggle
                     doesn't fire. -->
                <!-- #B.169: quick-access cog to the current project's
                     settings page — shorter route than the "strategy:
                     project settings →" hint that was the only entry
                     point before. Visible only when a specific
                     project is selected (the link makes no sense in
                     "All projects" mode). -->
                <button
                    v-if="project"
                    type="button"
                    class="sidebar-project-settings"
                    title="Project settings"
                    @click.stop="emit('open-current-settings')"
                >
                    <i class="pi pi-cog" />
                </button>
                <button
                    type="button"
                    class="sidebar-new-ticket"
                    title="New ticket"
                    @click.stop="emit('new-ticket')"
                >
                    <i class="pi pi-plus" />
                </button>
            </summary>
            <!-- #528 david : compteurs masquent le nom + l'icon moniteur +
                 l'icon dossier servent à pas grand chose. On vire les 2 icons
                 du project picker (sidebar-projects branch UNIQUEMENT — les
                 boutons settings gardent leurs icons), on style le label
                 selon p.running / p.local pour différencier (vert si une
                 loop tourne, muted-italic si local sans loop, normal sinon),
                 et on rétrécit les badges count.
                 #537 david : projets actifs (running OU pending/unread/resolved>0)
                 en haut, inactifs (juste open/snoozed) cachés derrière un
                 « More (N) » toggle. Le projet courant reste toujours visible
                 même s'il est inactif. -->
            <!-- All projects row (toujours en tête, quel que soit son état). -->
            <button
                v-if="allProjectItem"
                :key="'__all__'"
                type="button"
                class="sidebar-item sidebar-item--project"
                :class="{ active: panel === null && projectPage === null && project === null }"
                @click="emit('select', null)"
            >
                <span
                    class="sidebar-item-label sidebar-item-label--project"
                    :title="allProjectItem.label"
                >{{ allProjectItem.label }}</span>
                <span v-if="allProjectItem.pending > 0" class="sidebar-badge sidebar-badge--pending sidebar-badge--mini" :title="`${allProjectItem.pending} pending moderation`">{{ allProjectItem.pending }}</span>
                <span v-if="allProjectItem.resolved > 0" class="sidebar-badge sidebar-badge--resolved sidebar-badge--mini" :title="`${allProjectItem.resolved} resolution proposal${allProjectItem.resolved > 1 ? 's' : ''} waiting for your accept/reject`">{{ allProjectItem.resolved }}</span>
                <span v-if="allProjectItem.unread > 0" class="sidebar-badge sidebar-badge--unread sidebar-badge--mini" :title="`${allProjectItem.unread} unread tickets for you`">{{ allProjectItem.unread }}</span>
                <span v-if="allProjectItem.open > 0" class="sidebar-badge sidebar-badge--open sidebar-badge--mini" :title="`${allProjectItem.open} open tickets`">{{ allProjectItem.open }}</span>
            </button>
            <!-- Actifs : running OU comptables non-triviaux OU sélectionné. -->
            <button
                v-for="p in activeProjects"
                :key="p.value ?? '__active__'"
                type="button"
                class="sidebar-item sidebar-item--project"
                :class="{ active: panel === null && projectPage === null && project === p.value }"
                @click="emit('select', p.value)"
            >
                <span
                    class="sidebar-item-label sidebar-item-label--project"
                    :class="{
                        'sidebar-item-label--running': p.running && p.value,
                        'sidebar-item-label--local': p.local && !p.running && p.value,
                    }"
                    :title="p.running
                        ? `${p.label} — a claude-loop is running here`
                        : (p.local && p.value
                            ? `${p.label} — local (root known, no loop running)`
                            : p.label)"
                >{{ p.label }}</span>
                <span v-if="p.pending > 0" class="sidebar-badge sidebar-badge--pending sidebar-badge--mini" :title="`${p.pending} pending moderation`">{{ p.pending }}</span>
                <span v-if="p.resolved > 0" class="sidebar-badge sidebar-badge--resolved sidebar-badge--mini" :title="`${p.resolved} resolution proposal${p.resolved > 1 ? 's' : ''} waiting for your accept/reject`">{{ p.resolved }}</span>
                <span v-if="p.unread > 0" class="sidebar-badge sidebar-badge--unread sidebar-badge--mini" :title="`${p.unread} unread tickets for you`">{{ p.unread }}</span>
                <span v-if="p.open > 0" class="sidebar-badge sidebar-badge--open sidebar-badge--mini" :title="`${p.open} open tickets`">{{ p.open }}</span>
            </button>
            <!-- Inactifs : just open/snoozed, derrière un toggle. -->
            <button
                v-if="inactiveProjects.length > 0"
                type="button"
                class="sidebar-item sidebar-item--more"
                @click="inactiveOpen = !inactiveOpen"
                :title="inactiveOpen ? 'Hide inactive projects' : `Show ${inactiveProjects.length} inactive project${inactiveProjects.length > 1 ? 's' : ''}`"
            >
                <i :class="`pi ${inactiveOpen ? 'pi-chevron-up' : 'pi-chevron-down'}`" style="font-size: 0.7rem; opacity: 0.6" />
                <span class="sidebar-item-more-label">{{ inactiveOpen ? 'Less' : `More (${inactiveProjects.length})` }}</span>
            </button>
            <button
                v-for="p in (inactiveOpen ? inactiveProjects : [])"
                :key="`inactive-${p.value}`"
                type="button"
                class="sidebar-item sidebar-item--project sidebar-item--inactive"
                :class="{ active: panel === null && projectPage === null && project === p.value }"
                @click="emit('select', p.value)"
            >
                <span
                    class="sidebar-item-label sidebar-item-label--project"
                    :class="{ 'sidebar-item-label--local': p.local && !p.running && p.value }"
                    :title="p.local && p.value
                        ? `${p.label} — local (root known, no loop running)`
                        : p.label"
                >{{ p.label }}</span>
                <span v-if="p.open > 0" class="sidebar-badge sidebar-badge--open sidebar-badge--mini" :title="`${p.open} open tickets`">{{ p.open }}</span>
            </button>
        </details>

        <!-- Settings — visually pushed to the bottom on mobile via
             margin-top: auto so the section reads as a footer band
             (david's #B.161: "setting devrait aller en footer"). On
             desktop the natural flow keeps it under projects. -->
        <div class="sidebar-settings">
            <div class="sidebar-section-label">
                Settings
            </div>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'general' }"
                @click="emit('open-panel', 'general')"
            >
                <i class="pi pi-sliders-h" />
                <span>General</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'projects' }"
                @click="emit('open-panel', 'projects')"
            >
                <i class="pi pi-folder" />
                <span>Projects</span>
            </button>
            <!-- #457 puis #506 : les anciens panels moderation/work-filters
                 ont été retirés (le moteur unifié sert les 2 verdicts depuis
                 #483), l'entrée pointe directement vers la page Automation. -->
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'automation' }"
                @click="emit('open-panel', 'automation')"
            >
                <i class="pi pi-bolt" />
                <span>Automation</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'tags' }"
                @click="emit('open-panel', 'tags')"
            >
                <i class="pi pi-tag" />
                <span>Tags</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'consumers' }"
                @click="emit('open-panel', 'consumers')"
            >
                <i class="pi pi-users" />
                <span>Consumers</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'nodes' }"
                @click="emit('open-panel', 'nodes')"
            >
                <i class="pi pi-sitemap" />
                <span>Nodes</span>
            </button>
            <button
                type="button"
                class="sidebar-item"
                :class="{ active: panel === 'launchers' }"
                @click="emit('open-panel', 'launchers')"
            >
                <i class="pi pi-play" />
                <span>Launchers</span>
            </button>
        </div>

        <!-- Version footer (#341). Source: repo-root package.json, injected
             at build time via vite `define` (__AIBALL_VERSION__). -->
        <div class="sidebar-version" :title="`aiball ${appVersion}`">
            aiball v{{ appVersion }}
        </div>
    </aside>
</template>

<style>
.aiball-sidebar {
    border-right: 1px solid var(--p-content-border-color);
    padding: 0.8rem 0.6rem;
    background: var(--p-surface-50);
    overflow-y: auto;
    /* #B.134: fill the grid cell vertically so its internal overflow
       (this rule was already here, kept for explicitness) becomes the
       only scroll context — the parent .aiball-layout now owns
       overflow:hidden, so without height:100% the sidebar would just
       shrink-wrap its content and the page wouldn't scroll at all. */
    height: 100%;
    /* #B.161: flex column so the .sidebar-settings band can push to
       the bottom via margin-top: auto on mobile. */
    display: flex;
    flex-direction: column;
}
.sidebar-version {
    /* #341: small, muted build version pinned under the settings band. */
    margin-top: 0.6rem;
    padding: 0.35rem 0.4rem 0;
    border-top: 1px solid var(--p-content-border-color);
    font-size: 0.72rem;
    color: var(--p-text-muted-color);
    letter-spacing: 0.02em;
}
.sidebar-projects {
    /* #B.161: <details> default styling — chevron tighter. */
    margin-bottom: 1rem;
}
.sidebar-projects > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    /* #473 david `kqrgzj` : "si on choisit all l'écart est plus petit
       — peut etre lié au cog qui apparait". Le bouton cog
       (.sidebar-project-settings, 1.6rem×1.6rem) n'apparaît QUE quand
       un projet précis est sélectionné. Sans cog la row de la summary
       fait ~1.6rem (border-box, padding inclus dans min-height ci-
       dessous) ; avec cog elle fait ~2.1rem (1.6 cog content + 0.5
       padding) → écart vertical vers le 1er item plus grand "avec
       projet" que "All projects". On épingle la min-height au format
       AVEC cog (2.1rem = 1.6 cog + 0.5 du padding `0.3rem 0.6rem
       0.2rem` du sélecteur générique `.sidebar-section-label`) → la
       summary garde la même hauteur dans les 2 modes. */
    min-height: 2.1rem;
}
.sidebar-projects__label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sidebar-projects > summary::-webkit-details-marker {
    display: none;
}
.sidebar-projects > summary::before {
    content: "▾";
    color: var(--p-text-muted-color);
    font-size: 0.6rem;
}
.sidebar-projects:not([open]) > summary::before {
    content: "▸";
}
@media (min-width: 721px) {
    /* Desktop: project list is always open and click-locked
       (onProjectsSummaryClick preventDefault). The chevron would
       suggest collapsibility that doesn't apply here — drop it. */
    .sidebar-projects > summary {
        cursor: default;
    }
    .sidebar-projects > summary::before {
        display: none;
    }
}
.sidebar-new-ticket,
.sidebar-project-settings {
    background: transparent;
    /* #B.161 follow-up: no border around the cog/+ buttons next to
       the project name (david: "liseret autor du cog à coté nom
       projet pas utile") — hover background is enough affordance. */
    border: 0;
    border-radius: 0.3rem;
    width: 1.6rem;
    height: 1.6rem;
    align-items: center;
    justify-content: center;
    color: var(--p-text-muted-color);
    cursor: pointer;
    font-size: 0.85rem;
}
/* The + new-ticket button is a primary action — green tint, more
   prominent than the settings cog (david: "le bouton compact new
   ticket devrait etre vert"). */
.sidebar-new-ticket {
    color: var(--p-green-600);
}
.sidebar-new-ticket:hover {
    background: color-mix(in srgb, var(--p-green-500) 15%, transparent);
}
.sidebar-project-settings:hover {
    background: var(--p-surface-100);
}
/* The cog is shown on every viewport — quick access to current
   project's settings (#B.169). The [+] new-ticket is mobile-only
   (desktop has it in the InboxToolbar already). */
.sidebar-project-settings {
    display: inline-flex;
}
.sidebar-new-ticket {
    display: none;
}
@media (max-width: 720px) {
    .sidebar-new-ticket {
        display: inline-flex;
    }
}
.sidebar-settings {
    display: flex;
    flex-direction: column;
}
@media (max-width: 720px) {
    /* #B.161 mobile: settings hidden in the sidebar — App.vue
       renders a duplicate <SidebarFooter> after the inbox so the
       settings scroll naturally below the ticket list (david: "pas
       bloqué sur l'écran, vraiment en scroll apres la liste
       ticket"). Same look as desktop (vertical text list), just
       repositioned.
       Plus collapse the empty bottom space: shrink the sidebar to
       its content height instead of forcing 30vh. */
    .aiball-sidebar {
        max-height: none;
        height: auto;
    }
    .sidebar-settings {
        display: none;
    }
}
.sidebar-section-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--p-text-muted-color);
    /* #473 david : aligne le padding-x avec `.sidebar-item` (0.6rem) pour
       que le texte de la section-label démarre exactement au-dessus du
       texte des items (mêmes 0.6rem du bord gauche). Avant : 0.5rem côté
       label, 0.6rem côté items → décalage de 1.6px qui se voyait quand
       on switchait entre "All projects" actif (label tronqué = "All
       proje…") et un projet actif (label court = "aiball") où l'œil
       compare directement. */
    padding: 0.3rem 0.6rem 0.2rem;
}
.sidebar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 0.45rem 0.6rem;
    border-radius: 0.4rem;
    color: var(--p-text-color);
    cursor: pointer;
    font: inherit;
}
.sidebar-item:hover {
    background: var(--p-surface-100);
}
.sidebar-item.active {
    background: var(--p-primary-color);
    color: var(--p-primary-contrast-color);
}
.sidebar-item.active:hover {
    background: var(--p-primary-color);
}
.sidebar-item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
/* #528 — project row : pas d'icon ⇒ on récupère l'espace, le label peut
   utiliser tout le gap. Petit gap entre label + badges count. */
.sidebar-item--project { gap: 0.3rem; }
.sidebar-item-label--project { flex: 1; min-width: 0; }
/* #528 — différenciation par style du nom (remplace l'icon moniteur) :
   - running : couleur primaire + bold subtle pour signaler activité.
   - local sans running : italic muted (root connu mais loop éteinte).
   - sinon : normal.
   Sur la row .active (sélectionnée) on respecte le contrast color du
   bouton — l'override couleur ne s'applique qu'aux rows non-active. */
.sidebar-item-label--running { color: var(--p-green-500); font-weight: 600; }
.sidebar-item-label--local { font-style: italic; opacity: 0.85; }
.sidebar-item.active .sidebar-item-label--running,
.sidebar-item.active .sidebar-item-label--local { color: inherit; }
/* #537 — toggle « More (N) » pour révéler les projets inactifs. Visuellement
   discret : chevron + label muted, pas d'hover prominent. Les inactifs
   eux-mêmes héritent du style --local (déjà muted) ou rien. */
.sidebar-item--more {
    gap: 0.4rem;
    color: var(--p-text-muted-color);
    font-size: 0.78rem;
    padding-block: 0.25rem;
}
.sidebar-item-more-label { flex: 1; }
.sidebar-item--inactive { /* hérite du sidebar-item--project ; pas de tweak supplémentaire */ }
.sidebar-badge {
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    line-height: 1.2;
}
/* #528 — badges compteurs project : plus petits + plus serrés pour ne
   plus masquer le nom (compteurs étaient à 0.72rem + 0.4rem padding =
   ~28px wide pour un chiffre seul × 4 chips = ~110px volés au label). */
.sidebar-badge--mini {
    font-size: 0.65rem;
    padding: 0.02rem 0.3rem;
    min-width: 1.1rem;
    text-align: center;
}
.sidebar-badge--pending {
    background: var(--p-yellow-500);
    color: black;
}
.sidebar-badge--unread {
    background: var(--p-blue-500);
    color: white;
}
.sidebar-item.active .sidebar-badge--unread {
    background: white;
    color: var(--p-blue-500);
}
.sidebar-badge--resolved {
    background: var(--p-green-500);
    color: white;
}
.sidebar-item.active .sidebar-badge--resolved {
    background: white;
    color: var(--p-green-500);
}
.sidebar-badge--open {
    background: var(--p-surface-300);
    color: var(--p-text-color);
}
/* #528 — les anciennes classes `.sidebar-badge--local` / `--running` (avec
   le `pi-desktop` icon + pulse anim) ont été remplacées par le style sur
   `.sidebar-item-label--running` / `--local` ci-dessus (couleur + italic
   directement sur le nom). Plus de duplication d'info iconique. */
</style>
