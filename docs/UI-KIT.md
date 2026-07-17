# UI kit — build a mini admin, step by step

This is a walkthrough for anyone about to build an admin screen with aiball's
Vue components (`frontend/src/components/ui/`). It is deliberately **honest**:
every step was actually built, and the places where the kit fought back are
written down rather than smoothed over. The finished code lives in
[`../contrib/mini-admin/`](../contrib/mini-admin), one commit per step, so you
can read the diffs instead of trusting this page.

Read it before your first panel. The kit is genuinely good at what it was
built for — killing duplicated markup between panels — and genuinely absent
everywhere else. Knowing which is which saves a day.

- [What the kit is](#what-the-kit-is)
- [Step 1 — hello world](#step-1--hello-world)
- [Step 2 — list and detail](#step-2--list-and-detail)
- [Step 3 — rights](#step-3--rights)
- [Step 4 — menu and breadcrumb](#step-4--menu-and-breadcrumb)
- [Step 5 — children](#step-5--children)
- [What to expect](#what-to-expect)

## What the kit is

Ten components, in two families.

| Family | Components | What they give you |
| --- | --- | --- |
| Page scaffolding | `AdminDetailLayout`, `AdminDashboardLayout`, `DetailHeader`, `PanelHeader`, `SectionHeader` | the standard header / breadcrumb / card shapes |
| Content | `DataList`, `AsyncState`, `FieldRow`, `FormField`, `StatusPill` | tables, the loading/error/empty triad, label+value and label+input rows |

What the kit is **not**: it has no inputs, no buttons, no app shell, no
navigation, no router, no identity or permission concept. Those come from
PrimeVue or from you.

## Step 1 — hello world

Get a page on screen with one kit component. Read the commit: `mini-admin
step 1`.

You need a Vue app, and three things that are not obvious:

**The kit is not a package.** It is not published and has no entry point — you
reach it by path. The demo aliases it once instead of spreading
`../../../frontend/src/components/ui/…` everywhere, and the alias has to be
declared **twice**, in `vite.config.ts` and in `tsconfig.json`:

```ts
// vite.config.ts
const kit = fileURLToPath(new URL("../../frontend/src/components/ui", import.meta.url));
export default defineConfig({
    plugins: [vue()],
    resolve: { alias: { "@kit": kit } },
    // the import escapes the vite root, so allow the repo root explicitly
    server: { fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
```

**The global stylesheet is a hard dependency.** Kit components ship no scoped
styles of their own — their `.aiball-*` classes live in
`frontend/src/style.css`. Import it or you get bare HTML:

```ts
import "@frontend/style.css";
```

**PrimeVue is a hidden dependency, and it will not tell you.** The kit's CSS
reads `--p-content-background`, `--p-text-color`, `--p-content-border-color`
and friends. Nothing in this repo defines them: PrimeVue's Aura preset injects
them at runtime. Without it, everything compiles, the classes are in the
bundle, and the page renders shapeless. There is no error.

```ts
app.use(PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: ".aiball-dark" } } });
```

> **Trap.** `.aiball-main` is documented as the level-1 container in
> `AdminDashboardLayout`'s header comment, and `style.css` even carries an index
> comment pointing at it. It is defined inside the frontend's own `App.vue`, so
> it does **not** exist outside that app. Reaching for it fails silently — no
> build error, no typecheck error, just a page with no container. Define your
> own.

## Step 2 — list and detail

`DataList` in columns mode plus a detail page. Read the commit: `mini-admin
step 2`.

```vue
<DataList
    :columns="columns"
    :rows="rows"
    :loading="loading"
    :error="error"
    :is-empty="rows.length === 0"
    :row-key="(w: Widget) => w.id"
    default-sort-key="name"
    @row-click="(w: Widget) => emit('open', w.id)"
>
    <template #cell-status="{ row }">…</template>
    <template #empty>No widgets yet.</template>
</DataList>
```

Set `rowKey` on any list that sorts or removes rows, or Vue keys by index and
loses DOM identity. Sorting is internal: declare `sortable` on a column and
`DataList` handles the header clicks; pass `getSortValue` when a column's sort
value is derived rather than a plain field.

The detail side uses `AdminDetailLayout` (breadcrumb + card) with `AsyncState`
inside it, `FieldRow` for read-only values and `FormField` around each input.

> **Trap.** `FormField` gives you the label and the column — not the input. Its
> own usage example is `<InputText v-model="name" />`, which is PrimeVue's. Any
> form therefore drags PrimeVue in, which is what makes the hidden dependency
> above unavoidable rather than optional. Budget for it: one list and one form
> took the demo's bundle from 63 kB to 394 kB.

> **Trap.** `StatusPill` calls itself domain-agnostic, but its three statuses
> are `up` / `stale` / `down` — liveness words. If your entity is not "up", you
> will be translating your vocabulary into someone else's at every call site.

The kit is also inconsistent about where styles live, which matters the day you
try to use one component without the others: `PanelHeader` has no styles at all
(everything in `style.css`), `AdminDetailLayout` has a **non-scoped** `<style>`
with no CSS-variable fallbacks, and `StatusPill` has a scoped `<style>` **with**
fallbacks — so it degrades gracefully without PrimeVue while the others do not.

## Step 3 — rights

Rights in aiball live on the **server**: `bearerAuth` resolves a `consumer_id`
and a `token_kind` per request, and the route decides. The frontend carries no
permission model at all.

That is a coherent design for an API and an awkward one for a screen: a client
can only learn what it may do by being refused, and you cannot retroactively
hide a button you should never have offered. So a permission-aware page ends up
mirroring the server's rule client-side, and the rule now lives twice with
nothing keeping the copies honest. The demo does this in `session.ts` and the
duplication is deliberate — there is no better answer available today.

The kit gives you nothing here. Expect to pay three times:

- **No permission concept anywhere in the ten components.** Every caller
  re-invents the same `v-if` around every action.
- **Read and write are two unrelated components.** `FieldRow` (label + value)
  and `FormField` (label + input), with no read-only mode on either. A page
  whose rights vary at runtime **writes its whole body twice**. There is no
  kit-level workaround.
- **A refusal has no state.** `AsyncState` knows exactly `loading` / `error` /
  `empty`, so a 403 can only be dressed as an error — in red, next to a network
  failure. "You may not do this" and "the server broke" become the same screen,
  and they are not the same situation for the person reading it.

## Step 4 — menu and breadcrumb

Neither is automatic, and the breadcrumb **cannot** be.

`DetailHeader` takes `crumbs` as a **required prop** and never derives them. A
breadcrumb needs a parent; `frontend/src/lib/router.ts` has no tree to give one.
Its `RouteState` is a flat union of panel names with inbox concepts
(`statusFilter`, `onlyOpen`, `openTicketId`) welded into the type, and
`buildUrl` / `parseUrl` are two symmetric `if/else` chains over those literals.
Adding a page means editing the union **and** both chains. Nothing in it is
reusable by another app.

The consequence is mechanical, not sloppy: every page hand-writes its chain, and
the chains drift. Four sibling project pages already carry two different ones.

If you are building outside the frontend, write your own router over a **table**
and derive the chain by walking parents:

```ts
export const ROUTES: Route[] = [
    { path: "/", label: "Home", inMenu: true },
    { path: "/widgets", label: "Widgets", parent: "/", inMenu: true },
    { path: "/widgets/:id", label: "Widget", parent: "/widgets" },
];
```

Nine lines derive what eight pages type out by hand.

There is no nav component either. The frontend's menu lives inside its own
`App.vue`, non-scoped and unexported — the same shape as `.aiball-main`:
readable, unusable.

## Step 5 — children

A child table inside the parent's detail card, and a child detail at a third
breadcrumb level. This is the step that tests the previous four.

**This is where the kit shines.** `DataList` and `SectionHeader` nest inside a
detail card with no ceremony at all — purely additive, nothing reopened. If your
screen is a table inside a section inside a card, the kit does exactly its job.

**And it is where flat designs break.** Nesting is the first real test of
anything you wrote earlier:

- A crumb builder that emits `href: route.path` works until the parent carries
  params — then it emits the literal `/widgets/:id`. The demo shipped this bug
  in step 4 and only found it in step 5. Substitute the current match's params.
- A flat `canEdit` boolean does not cascade. It knows nothing of "this widget"
  or "its parts", so the child restates the parent's rule verbatim. The day
  rights become per-entity, that `v-if` is a lie.
- The read/write duplication from step 3 gets paid again, per page, forever.

## What to expect

The kit is additive exactly where it is a **visual shell** — tables, sections,
headers, the loading triad — and never where a concern is **transversal**:
bootstrap, rights, routing, identity. All four of those live privately inside
the frontend's `App.vue`.

That is the scope it was built for, not a failure: it exists to stop panels from
duplicating markup, and at that it works. It was simply never asked to be a
foundation, and until this demo it never had a second consumer to find out.

Practically, for your first screen:

- Copy the bootstrap from [`../contrib/mini-admin/src/main.ts`](../contrib/mini-admin/src/main.ts).
  It is short, constant, and identical for everyone.
- Do not reach for `.aiball-main`, the router, the nav, or any permission
  helper. They are not there.
- Reach for `DataList`, `AsyncState`, `SectionHeader`, the layouts. They are
  good, and they compose.
- Assume anything transversal is yours to build, and that adding it later will
  reopen your earlier files.

The demo is built in CI (`contrib-build`) and covered by `make typecheck`, so
if the kit changes under it, this page breaks loudly instead of rotting.
