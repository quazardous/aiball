# Frontend structure

How the aiball frontend (`frontend/`) is organized — the map a contributor
needs before touching a screen: build & entry, routing, component layout, the
data layer, styling, and the conventions that bite if you don't know them.

It's a **Vue 3** app (`<script setup lang="ts">` single-file components) on
**PrimeVue** (Aura theme). No Vue Router, no Pinia — routing and cross-component
state are hand-rolled and small on purpose. All paths below are under `frontend/`.

> **Rebuild after every UI edit.** The daemon serves the *built* bundle from
> `frontend/dist/` (gitignored), so source edits don't reach the browser until
> `cd frontend && npm run build` regenerates it. `vue-tsc --noEmit` only
> typechecks — it does **not** emit `dist/`. Hard-reload the browser after.

## Build & entry

| Concern | File | Role |
|---|---|---|
| Build tool | `vite.config.ts` | Vite + `@vitejs/plugin-vue`. `base: "./"` (relative asset URLs so one build runs under any mount path). Injects `__AIBALL_VERSION__` from the repo-root `package.json`. Dev proxy: `/api`→daemon, `/ws`→websocket. Alias `@shared`→repo-root `src/`. |
| Build script | `package.json` | `build` = `vue-tsc --noEmit && vite build`, output `dist/`. `dev` = vite dev server. |
| HTML entry | `index.html` | Loads `/src/main.ts`; carries a trailing-slash probe/redirect for sub-path mounts. |
| JS entry | `src/main.ts` | Creates the app, registers PrimeVue (Aura preset, `darkModeSelector: ".aiball-dark"`), `ToastService`, `ConfirmationService`; imports `style.css` + `styles/theme-dark.css`; mounts `#app`. |
| Root | `src/App.vue` | The app shell + orchestrator: auth gate, filter/pagination state, top-level screen switching, websocket/bus wiring. There is no separate layout component — most top-level state lives here. |
| Served by | repo-root `src/app.ts` (`express.static(dist)` + SPA fallback), from `src/daemon.ts` | The daemon serves `frontend/dist`; `dist/` is gitignored → rebuild required. |

## Routing / screens

No router library. `src/lib/router.ts` is a custom **hash router** (`RouteState`,
`buildUrl`/`parseUrl`, `useRouting(refs)` binding reactive refs to
`location.hash`) so the served path stays the base regardless of mount point;
`src/lib/base.ts` handles base-path detection + `pushRoute`/`resetToRoot`.
Screen selection is `v-if`/`v-else-if` in `App.vue` driven by refs
(`panel` / `openTicketId` / `projectPage` / `*EditId`). An auth mode
(`loading | setup | login | ready`) gates the shell.

| Route (hash) | Screen | Component |
|---|---|---|
| `/setup` | First-run install token | `SetupScreen.vue` |
| `/login` | Login | `LoginScreen.vue` |
| `/` | Inbox list | `InboxToolbar` + `InboxList` + `PaginationBar` + `BulkBar` |
| `/b/<id>` (alias `/t/<id>`) | Ticket thread | `ThreadView.vue` |
| `/new` | Compose ticket | `NewTicketPage.vue` |
| `/general` | General settings | `GeneralSettingsPanel.vue` |
| `/automation`, `/automation/rules/<id>` | Automation rules | `AutomationPanel.vue` → `AutomationRuleDetailPage.vue` |
| `/tags` | Tag catalog | `TagsPanel.vue` |
| `/projects` | Projects admin | `ProjectsPanel.vue` |
| `/consumers`, `/consumers/<id>` | Consumers | `ConsumersPanel.vue` → `ConsumerEditPage.vue` |
| `/nodes`, `/nodes/<id>` | Proxy nodes | `NodesPanel.vue` → `NodeDetailPage.vue` |
| `/launchers` | Launchers | `LaunchersPanel.vue` |
| `/usage` | Token usage | `UsagePanel.vue` |
| `/overview` (+ legacy `/stats`,`/settings`,`/detail`, need `?p=`) | Per-project pages | `ProjectOverviewPage.vue` (tabs) + `ProjectStatsPage` / `ProjectSettingsPage` / `ProjectDetailPage` |

Query params: `?p=` (project scope), `?status=`, `?open=`.

## Components (`src/components/`)

Mostly flat, with one nested feature dir (`automation/`) and the UI kit (`ui/`).
By role:

- **Shell / chrome** — `HeaderBar.vue` (connection pip, global badges, dark/snooze toggles), `Sidebar.vue` (project list + settings nav).
- **Inbox** — `InboxList.vue`, `InboxToolbar.vue`, `InboxSearchResults.vue`, `ListRow.vue`, `PaginationBar.vue`, `BulkBar.vue`, `MobileProjectPicker.vue`.
- **Thread** (children of `ThreadView.vue`) — `ThreadHeader`, `ThreadMetaHeader`, `ThreadToolbar`, `ThreadCommentsList`, `ThreadEditPanel`, `ThreadManagePanel`, `ThreadActionsDock`, `ThreadRelations`, `CommentNode`, `CommentVotes`, `RelationChip`, `RelationKindMenu`, `MessageComposer` (shared with compose).
- **Compose** — `NewTicketPage.vue`, `MessageComposer.vue`, `IdentityPicker.vue`.
- **Admin panels** — `GeneralSettingsPanel`, `AutomationPanel` / `AutomationRulesSection`, `TagsPanel` / `TagPicker` / `TagBadge`, `ConsumersPanel` / `ConsumerEditPage` / `ConsumerEditForm` / `ConsumerOverview`, `NodesPanel` / `NodeDetailPage`, `UsagePanel` / `TokenUsageChart`, `LaunchersPanel`, `ManagedConfig`, `ProjectsPanel` + the four `Project*Page.vue`.
- **Automation rule builder** (`components/automation/`) — `RuleEditor`, `ActionBlock`, `ConditionNode`, `ConditionLeafBlock`, `ContainerBlock`.
- **Shared display** — `MarkdownView.vue` (marked + DOMPurify + highlight.js), `PriorityIcon.vue`, `TerminalView.vue` (xterm).

### The UI kit — `src/components/ui/`

Domain-agnostic layout/display primitives (a 3-level admin layout system). Use
these when building a new admin screen instead of re-bespoking headers/tables/
states — they're what keep the admin panels visually consistent.

| Component | Purpose |
|---|---|
| `PanelHeader.vue` | Admin panel header: title + `#actions` slot + explainer. |
| `AsyncState.vue` | Loading / Error / Empty triad wrapper around async data. |
| `DataList.vue` | Admin table shell (declarative columns or slot mode). |
| `SectionHeader.vue` | In-page `<h3>` + hint pair. |
| `AdminDashboardLayout.vue` | Full-width multi-section detail-page layout. |
| `AdminDetailLayout.vue` | Narrow form-style single-entity page layout. |
| `DetailHeader.vue` | Breadcrumb + title + `#actions` for detail/edit pages. |
| `FieldRow.vue` | Read-only label/value row (detail pages). |
| `FormField.vue` | Form field (label + input slot). |
| `StatusPill.vue` | Colored liveness dot + label (generic 3-state). |

All are genuinely reused across the panels above; none is an orphan.

## State & data layer

- **API client** — `src/lib/api.ts`: a single `api` object of typed REST calls to `/api/*` plus the shared TS interfaces. Owns the auth token (`localStorage["aiball.token"]`, `setAuthToken`/`clearAuthToken`/`setUnauthorizedHandler`); URLs go through `withBase()`.
- **Live updates** — `src/lib/ws.ts` (`useWs`, typed `WsEvent` union, reconnect on visibility) → `src/lib/inbox-ws.ts` (`useInboxWs` relays WS events onto the bus). WebSocket, no SSE.
- **Event bus** — `src/lib/bus.ts`: a tiny typed pub/sub (`bus.emit` / `useBus`), deliberately chosen over a store. Cross-component reactions go through it; new events extend the `BusEvents` map (TS enforces the payload).
- **Shared refs** — `src/lib/prefs.ts` (localStorage-synced preference refs); app-level state lives in `App.vue` refs.
- **Composables** (`use*` in `lib/`) — `useRouting`, `useLoader`, `useNotifications`, `useBulkActions`, `useInboxWs`, `useThreadItems`, plus helpers (`autoMarkRead`, `now-ticker`, `node-liveness`, `mention-autocomplete`, …).
- **Enums / labels / formatting** — `lib/domain.ts` re-exports the daemon's business enums via `@shared` (single source, no drift); `lib/labels.ts` (UI string/icon/option catalogs), `lib/format.ts` (pure formatters), `lib/formatting.ts` (config-driven linkifier for `MarkdownView`), plus `scope.ts`, `time.ts`, `relations.ts`, `decisions.ts`.

## Styling

- **Tokens + global CSS** — `src/style.css`: `:root` defines font sizes (`--fs-*`), radii (`--radius-*`), `--font-mono`. Colors/surfaces come from PrimeVue Aura variables (`--p-*`).
- **The `.aiball-*` convention** — app-level structural/utility classes are prefixed `.aiball-` (`.aiball-shell`, `.aiball-layout`, `.aiball-main`, `.aiball-section`, `.aiball-field`, `.aiball-explainer`, `.aiball-detail-page`, `.aiball-mono`, …). Component-specific rules live in each SFC's own `<style>` block; some ship a sibling `.css` file (e.g. `ThreadView.css`).
- **Dark mode** — `src/styles/theme-dark.css` is **auto-generated** by `scripts/extract-theme-dark.mjs` (overrides scoped under `.aiball-dark`). Don't hand-edit it: edit the component `<style>` + rerun the script. Dark mode is toggled by adding `.aiball-dark` to `<html>` (App.vue), which also flips PrimeVue's `darkModeSelector`.

## Conventions & gotchas

- **Rebuild after every UI edit** (see the banner up top) — the daemon serves `dist/`.
- **Enums come from the backend** — never hand-mirror a business enum in the frontend; extend the repo-root `src/domain.ts` and consume via `lib/domain.ts` / `@shared`.
- **Bus over stores** — cross-component reactions go through `lib/bus.ts`, not a global store.
- **`theme-dark.css` is generated** — edit component styles + rerun the extractor, never the generated file.
- **`App.vue` is the orchestrator** — a new screen = another `v-if` branch in `App.vue` + a route case in `lib/router.ts`.
- **Hash routing under any base path** — assets are relative and the route lives in `location.hash`; don't assume absolute paths.
- **Dead-code lint** — ESLint with `eslint-plugin-unused-imports` is configured; unused imports fail lint.
