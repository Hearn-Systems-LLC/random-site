# random random — a chooser that chooses a chooser

Design doc. 2026-07-27.

## Summary

A sixth built-in chooser, slug `random`, served at `random.oddspark.dev/c/random`.
Pressing it picks one chooser from a visitor-configurable pool, then delegates to
that chooser's own press behavior. The result renders in the meta card in its
native form — a swatch for `color`, a canvas for `shape`, a server pick for a
user chooser — labeled with what it landed on.

## Why this is small

`bindCard` (`src/worker.js:857`) already dispatches on `data-kind`/`data-type` to
`pressNumber`/`pressColor`/`pressShape`/`pressList`/`pressKv`. Each takes the card
as its first argument and renders into that card's own `.result` element. The meta
chooser is that same dispatch with the type chosen at random rather than read from
an attribute, so rendering comes free for every result shape.

## Decisions

### 1. Identity and placement

- Added to `BUILTINS` as `{ slug: "random", name: "random random", kind: "builtin", type: "meta", blurb: ... }`.
- Rendered by the existing `cardHtml` path on both the homepage grid and `/c/random`.
- `BUILTIN_MAP` gains `random`, which makes the existing slug-collision logic
  automatically rewrite a visitor-created chooser named "random" to
  `random-<4 hex>`. No new reserved-word handling needed.
- Text-mode output (`chooserAsText`, `homeAsText`) inherits built-in treatment
  unchanged: no `curl -X POST /api/pick/...` line, since built-ins are browser-only.
- It never selects itself.

### 2. Candidate pool is visitor-configurable

`cardHtml` gains a `type === "meta"` branch. The card's `.ctl` slot — the same
slot `number` uses for its min/max inputs (`src/worker.js:512-519`) — holds:

- two group checkboxes: **built-ins** and **user-made**
- a `customize` `<details>` disclosure containing a scrollable per-chooser
  checkbox list, built from the manifest, for arbitrary combinations

Collapsed by default, so the resting state is two checkboxes.

### 3. Counters

Landing on a user chooser calls the existing `POST /api/pick/:slug`, which
increments that chooser's Durable Object counter. An indirect press is still a
press. This requires zero new server code.

`random` itself has no press counter, consistent with the other five built-ins
(`cardHtml` only emits the `.count` div when `kind !== "builtin"`).

### 4. Selection persists in localStorage, stored as exclusions

Stored shape:

```json
{ "builtins": true, "users": true, "off": ["some-slug"] }
```

Group flags plus an explicit opt-out list — **not** an include list. The shelf
grows by up to one chooser per person per day; an include list would silently
exclude every newly created chooser forever, so anything new must be in by
default.

On load: unknown slugs in `off` are dropped; missing or malformed storage falls
back to everything-on.

### 5. The chooser manifest is inlined, not fetched

`page()` already hands data to the client by string substitution
(`CLIENT_SCRIPT.replace("__LISTS__", listsJson)`, `src/worker.js:1018`). A second
placeholder, `__CHOOSERS__`, carries `[{slug, name, kind, type}]` for every
chooser on the shelf.

Chosen over fetching `GET /api/choosers` (which already exists,
`src/worker.js:1190`) because the server already holds this data when it renders
the page; fetching it would add a round-trip per press for nothing.

Chosen over scraping `.card[data-slug]` from the DOM because the permalink page
renders only one card, so the meta chooser would silently see a pool of one.

The home route already has `users` in hand (`src/worker.js:1230`). The permalink
route does not — it looks up only the requested slug — so it gains a
`listUserChoosers` call **gated on `slug === "random"`**, leaving every other
permalink view at its current single-lookup cost.

### 6. Press flow

```
pool = manifest
     ∩ enabled groups
     − off[]
     − self ("random")

pool empty → Press disabled, hint "nothing selected"
otherwise  → chosen = pick(pool)
             write "via {chosen.name}" into a .via element
               sitting above .result, inside the meta card
             dispatch on chosen (each renders into .result as usual):
               number → pressNumber(metaCard)
               color  → pressColor(metaCard)
               shape  → pressShape(metaCard)
               list   → pressList(metaCard, chosen.slug)
               user   → pressKv(metaCard, chosen.slug, btn)
```

`pressNumber` reads `.num-min`/`.num-max` off the card (`src/worker.js:757-758`),
which the meta card does not have. It already falls back to `1` and `100` when
values are unparseable, but it also writes clamped values back to `input.value`,
which throws when the inputs are absent. A guard makes the fallback path work
with no inputs present, giving `random` → `number` a 1–100 roll — the same
default the `number` card ships with.

### 7. Error handling

- `pressKv` failures route to the existing `showErr` path and re-enable the
  button. Inherited unchanged.
- Empty pool disables the button rather than failing at press time.
- A user chooser deleted between page render and press surfaces as the existing
  `"no pick: ..."` error.
- Stale `off` slugs are dropped at load.

### 8. Testing

CI (`.github/workflows/test.yml`) already runs `node test.mjs` on every push and
pull request, with no dependency install step. The gap is not the trigger — it is
that client logic living inside the `CLIENT_SCRIPT` string is unreachable from
Node.

**Extract the set math.** `computePool(manifest, state) → candidates[]` is pure:
no DOM, no fetch. It is defined at module scope in `worker.js`, exported for
tests, and injected into the client script via
`.replace("__POOL_FN__", computePool.toString())`. Node tests the real function;
the browser runs its literal source text. One source of truth, no build step.

Constraint: because its source text is injected into a deliberately old-style
script, `computePool` must be written in that dialect — `var` and `function`, no
`const`/arrow. It will look unlike the rest of `worker.js`; a comment at the
definition explains why.

Tests added to `test.mjs`:

- group flags off/on filter correctly
- explicit `off[]` slugs are excluded
- `random` never selects itself
- empty pool returns `[]`, proving the button-disable path is reachable
- a chooser absent from `off[]` is included by default — locks in the
  exclusion-list decision in §4 against a future refactor inverting it
- `random` is present in `BUILTINS` with `type: "meta"`
- `/c/random` returns 200 and includes the selector controls
- the `__CHOOSERS__` manifest is inlined on both `/` and `/c/random` and contains
  user choosers
- other permalinks do not trigger the extra `listUserChoosers` call
- creating a chooser named "random" collides to `random-<4 hex>`
- `new Function(CLIENT_SCRIPT)` parses, closing the failure class where a typo in
  that string ships silently and breaks only in the browser

**Not covered:** DOM dispatch and rendering (e.g. `pressColor` drawing a swatch
into the meta card). Covering it needs jsdom — which breaks the "no dependencies
to install" property `test.yml` calls out — or a browser driving `wrangler dev`.
The judgment is that the set math is where bugs will live and the five rendering
functions are already working in production. This is a deliberate tradeoff, not
an oversight.

## Follow-on work, not in this change

**Random Day** — a built-in with `type: "list"` and the seven weekday names
(Sunday through Saturday), same shape as `animal` and `simpsons-character`. No new
machinery; it becomes a candidate in the `random` pool automatically once added.
