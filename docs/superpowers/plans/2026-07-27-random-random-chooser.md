# random random Chooser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in chooser at `/c/random` that picks a chooser from a visitor-configurable pool, then delegates to that chooser's own press behavior.

**Architecture:** A sixth entry in `BUILTINS` with `type: "meta"`. The pool set math lives in an exported `computePool()` injected into the browser via `.toString()`, so Node and the browser run the same source. The candidate list is inlined into the page as a `__CHOOSERS__` placeholder, matching the existing `__LISTS__` mechanism. Pressing dispatches to the existing `pressNumber`/`pressColor`/`pressShape`/`pressList`/`pressKv` functions against the meta card, so every result shape renders for free.

**Tech Stack:** Cloudflare Workers, single-file `src/worker.js`, no build step. Tests are a hand-rolled `check()` harness in `test.mjs` run by `node test.mjs`.

**Spec:** `docs/superpowers/specs/2026-07-27-random-random-chooser-design.md`

## Global Constraints

- **No new dependencies.** `.github/workflows/test.yml` has no install step and runs `node test.mjs` directly. Adding a devDependency breaks CI.
- **No build step.** The project ships one file; do not introduce a bundler or transpiler.
- **`computePool` must not reference module scope.** Its source text is injected into the browser via `.toString()`. Any reference to a module-level `const` compiles fine in Node and throws `ReferenceError` in the browser. The meta slug `"random"` is therefore hardcoded inside the function body, deliberately.
- **Client-script dialect:** `var` and `function` only — no `const`, `let`, or arrow functions — inside `CLIENT_SCRIPT` **and** inside `computePool`. The rest of `src/worker.js` uses modern syntax; these two places do not.
- **String-replacement safety:** `String.prototype.replace` treats `$&`, `$'`, and `` $` `` in the *replacement* as special. New replacements must use the function form (`.replace(token, function(){ return value })`) because chooser names are visitor-supplied and can contain `$`.
- **`npm test` must stay green.** Run it after every task.
- **Commit style:** lowercase type prefix, then a prose body explaining *why*. No trailing attribution footers — see `git log`.

---

### Task 1: `computePool` — the pure set math

The only logic with real branching. Pure in, pure out: no DOM, no fetch, no module-scope reads. Nothing user-visible ships in this task.

**Files:**
- Modify: `src/worker.js` (add exported function immediately after the `BUILTIN_MAP` line, ~line 64)
- Test: `test.mjs` (new section after section 1)

**Interfaces:**
- Consumes: nothing
- Produces: `computePool(manifest, state) -> Array<{slug, name, kind, type}>`
  - `manifest`: `Array<{slug, name, kind, type}>`
  - `state`: `{builtins: boolean, users: boolean, off: string[]}`
  - Returns the subset of `manifest` that is enabled, never including `slug === "random"`

- [ ] **Step 1: Write the failing tests**

Add to `test.mjs`, immediately after the section 1 block that ends with the `simpsons list >= 48 items` check. Also add `computePool` to the import on line 1:

```js
import worker, { BUILTINS, Counters, slugify, computePool } from "./src/worker.js";
```

```js
/* 1b. computePool set math ----------------------------------------- */
const MANIFEST = [
  { slug: "random", name: "random random", kind: "builtin", type: "meta" },
  { slug: "number", name: "number", kind: "builtin", type: "number" },
  { slug: "color", name: "color", kind: "builtin", type: "color" },
  { slug: "dino", name: "random dinosaur", kind: "user" },
  { slug: "pizza", name: "random pizza topping", kind: "user" },
];
const ALL_ON = { builtins: true, users: true, off: [] };
const slugsOf = (p) => p.map((c) => c.slug).sort().join(",");

check(
  "everything on returns all but self",
  slugsOf(computePool(MANIFEST, ALL_ON)) === "color,dino,number,pizza",
  slugsOf(computePool(MANIFEST, ALL_ON))
);
check(
  "never selects itself",
  computePool(MANIFEST, ALL_ON).every((c) => c.slug !== "random")
);
check(
  "builtins off leaves only user choosers",
  slugsOf(computePool(MANIFEST, { builtins: false, users: true, off: [] })) === "dino,pizza",
  slugsOf(computePool(MANIFEST, { builtins: false, users: true, off: [] }))
);
check(
  "users off leaves only built-ins",
  slugsOf(computePool(MANIFEST, { builtins: true, users: false, off: [] })) === "color,number",
  slugsOf(computePool(MANIFEST, { builtins: true, users: false, off: [] }))
);
check(
  "both groups off returns empty",
  computePool(MANIFEST, { builtins: false, users: false, off: [] }).length === 0
);
check(
  "off list excludes named slugs",
  slugsOf(computePool(MANIFEST, { builtins: true, users: true, off: ["color", "dino"] })) === "number,pizza",
  slugsOf(computePool(MANIFEST, { builtins: true, users: true, off: ["color", "dino"] }))
);
check(
  "unknown slug in off is harmless",
  slugsOf(computePool(MANIFEST, { builtins: true, users: true, off: ["gone-forever"] })) === "color,dino,number,pizza"
);
// Locks in the exclusion-list decision: a chooser created after a visitor
// saved preferences must be IN by default, not silently absent forever.
check(
  "chooser absent from off[] is included by default",
  computePool(
    MANIFEST.concat([{ slug: "brand-new", name: "random new thing", kind: "user" }]),
    { builtins: true, users: true, off: ["color"] }
  ).some((c) => c.slug === "brand-new")
);
check(
  "self excluded even when groups are on and off[] is empty",
  computePool([{ slug: "random", name: "random random", kind: "builtin", type: "meta" }], ALL_ON).length === 0
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: exits 1, with lines reading `FAIL everything on returns all but self` and similar. The import of `computePool` will be `undefined`, so the calls throw — if the run crashes with `TypeError: computePool is not a function` instead of printing FAILs, that is also an acceptable red state.

- [ ] **Step 3: Write the implementation**

In `src/worker.js`, immediately after the `const BUILTIN_MAP = ...` line (~line 64):

```js
/* ------------------------------------------------------------------ *
 * computePool: which choosers is the "random random" card allowed to
 * land on, given the visitor's saved preferences?
 *
 * Written in the client script's dialect (var / function, no const or
 * arrows) and deliberately self-contained -- no module-scope reads --
 * because its SOURCE TEXT is injected into the browser via
 * .toString(). A reference to anything outside this function body
 * would work in Node and throw ReferenceError in the browser. That is
 * also why "random" is hardcoded here rather than shared as a const.
 * ------------------------------------------------------------------ */
export function computePool(manifest, state) {
  var wantBuiltins = !state || state.builtins !== false;
  var wantUsers = !state || state.users !== false;
  var off = (state && state.off) || [];
  var out = [];
  for (var i = 0; i < manifest.length; i++) {
    var c = manifest[i];
    if (c.slug === "random") continue;
    if (c.kind === "builtin" ? !wantBuiltins : !wantUsers) continue;
    if (off.indexOf(c.slug) !== -1) continue;
    out.push(c);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all checks pass, exit 0. The count line should show 10 more passing checks than before.

- [ ] **Step 5: Commit**

```bash
git add src/worker.js test.mjs
git commit -m "feat: computePool, the random random pool set math

Pure function deciding which choosers the meta chooser may land on.
Written closure-free and in the client script's dialect because its
source text will be injected into the browser via .toString(), so Node
and the browser run identical code with no build step.

Stores preferences as exclusions rather than inclusions, so choosers
created after a visitor saves preferences are in by default; a test
locks that property against a future refactor inverting it."
```

---

### Task 2: Register the built-in and render its card

Adds the card to the shelf. **The card is inert until Task 4** — pressing it does nothing useful yet. That is expected at this checkpoint.

**Files:**
- Modify: `src/worker.js` — `BUILTINS` array (~line 56), `cardHtml` (~line 510), `CSS` (~line 616)
- Test: `test.mjs` — section 1 built-in checks, plus a new permalink section

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: a `BUILTINS` entry `{slug: "random", name: "random random", kind: "builtin", type: "meta", blurb: ...}`; card markup containing `.pool-builtins`, `.pool-users`, `.pool-list`, and `.via` elements that Task 4 binds to

- [ ] **Step 1: Write the failing tests**

First **update** the two existing section 1 checks in `test.mjs` (they assert five built-ins and will now fail):

```js
check("six built-ins", BUILTINS.length === 6, BUILTINS.map((b) => b.slug).join(","));
check(
  "built-in slugs",
  ["number", "color", "shape", "animal", "simpsons-character", "random"].every((s) =>
    BUILTINS.some((b) => b.slug === s)
  )
);
```

Then add a new section at the end of `test.mjs`, immediately before the `/* report */` block:

```js
/* 9. random random card -------------------------------------------- */
const meta = BUILTINS.find((b) => b.slug === "random");
check("random is a meta built-in", !!meta && meta.type === "meta" && meta.kind === "builtin");
check("random has no items list", !!meta && meta.items === undefined);

const rMeta = await worker.fetch(req("/c/random", { headers: { accept: "text/html" } }), env, ctx);
const metaHtml = await rMeta.text();
check("/c/random returns 200", rMeta.status === 200, rMeta.status);
check("meta card carries data-type=meta", metaHtml.includes('data-type="meta"'));
check("meta card has group toggles", metaHtml.includes("pool-builtins") && metaHtml.includes("pool-users"));
check("meta card has a customize list container", metaHtml.includes("pool-list"));
check("meta card has a via slot", metaHtml.includes('class="via"'));
check("meta card has no press counter", !/<div class="count">/.test(metaHtml));

/* text mode must survive a built-in with no items list */
const rMetaTxt = await worker.fetch(req("/c/random", { headers: { accept: "text/plain" } }), env, ctx);
const metaTxt = await rMetaTxt.text();
check("/c/random text mode returns 200", rMetaTxt.status === 200, rMetaTxt.status);
check("meta text names the chooser", metaTxt.includes("random random"), metaTxt.slice(0, 60));
check("meta text offers no curl press", !metaTxt.includes("/api/pick/random"));

const rHomeTxt = await worker.fetch(req("/", { headers: { accept: "text/plain" } }), env, ctx);
check("home text mode returns 200", rHomeTxt.status === 200, rHomeTxt.status);

/* a visitor naming their chooser "random" must not squat the built-in */
const cookieR = await freshCookie();
const rSquat = await worker.fetch(
  postJson("/api/create", { name: "random" }, { cookie: "rc_uid=" + cookieR }),
  env,
  ctx
);
const squat = await rSquat.json();
check("create named 'random' returns 200", rSquat.status === 200, rSquat.status);
check("'random' collides to random-<4 hex>", /^random-[0-9a-f]{4}$/.test(squat.slug || ""), squat.slug);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: exits 1. `six built-ins` FAILs with detail listing five slugs; `/c/random returns 200` FAILs with detail `404`; the card-markup checks FAIL.

- [ ] **Step 3a: Add the BUILTINS entry**

In `src/worker.js`, append as the last element of the `BUILTINS` array (after the `simpsons-character` entry, keeping the familiar choosers first in the grid):

```js
  { slug: "random", name: "random random", kind: "builtin", type: "meta", blurb: "picks a chooser, then picks something from it" },
```

- [ ] **Step 3b: Add the `cardHtml` meta branch**

In `cardHtml`, extend the existing `controls` block (currently only handles `"number"`):

```js
  let controls = "";
  if (c.type === "number") {
    controls =
      '<div class="ctl">' +
      '<label>min <input type="number" class="num-min" value="1" step="1"></label>' +
      '<label>max <input type="number" class="num-max" value="100" step="1"></label>' +
      "</div>";
  } else if (c.type === "meta") {
    // The per-chooser list is filled in by the client from the inlined
    // manifest; cardHtml only ever sees one chooser, not the shelf.
    controls =
      '<div class="ctl ctl-pool">' +
      '<label class="grp"><input type="checkbox" class="pool-builtins" checked> built-ins</label>' +
      '<label class="grp"><input type="checkbox" class="pool-users" checked> user-made</label>' +
      "</div>" +
      '<details class="pool-more"><summary>customize</summary>' +
      '<div class="pool-list"></div></details>';
  }
```

Then add the `.via` slot. Directly above the `return (` statement:

```js
  const via = c.type === "meta" ? '<div class="via" aria-live="polite"></div>' : "";
```

and insert `via` into the returned markup between `controls` and the `.result` div:

```js
    controls +
    via +
    '<div class="result" aria-live="polite"><span class="hint">&mdash; press &mdash;</span></div>' +
```

- [ ] **Step 3c: Add the CSS**

In the `CSS` template literal, immediately after the existing `.ctl input:focus` rule (~line 625):

```css
  .ctl-pool{flex-wrap:wrap}
  .ctl-pool .grp{
    display:flex; align-items:center; gap:5px; cursor:pointer;
    font-size:12px; color:var(--dim);
  }
  .pool-more{margin-top:8px}
  .pool-more summary{
    color:var(--faint); font-size:10.5px; letter-spacing:.12em;
    text-transform:uppercase; cursor:pointer;
  }
  .pool-list{
    max-height:132px; overflow-y:auto; margin-top:6px;
    display:flex; flex-direction:column; gap:4px;
  }
  .pool-list label{
    display:flex; align-items:center; gap:6px;
    font-size:12px; color:var(--dim); cursor:pointer;
  }
  .via{
    color:var(--faint); font-size:10.5px; letter-spacing:.12em;
    text-transform:uppercase; min-height:14px;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all checks pass, exit 0.

- [ ] **Step 5: Eyeball it**

Run: `npx wrangler dev` and open the printed URL. Confirm the `random random` card appears last among the built-ins with two checked group boxes and a `customize` disclosure that expands to an empty area. Pressing it does nothing yet — correct for this checkpoint.

- [ ] **Step 6: Commit**

```bash
git add src/worker.js test.mjs
git commit -m "feat: random random card markup, styles, and built-in entry

Sixth built-in, rendered through the existing cardHtml path so the
homepage grid and /c/random stay identical. The per-chooser customize
list ships empty because cardHtml only ever sees one chooser; the
client fills it from the inlined manifest.

Adding random to BUILTIN_MAP also makes the existing collision logic
rewrite a visitor-created 'random' to random-<4 hex> with no new
reserved-word handling.

The card is inert until the client wiring lands."
```

---

### Task 3: Inline the manifest and `computePool` into the page

Server-side plumbing to hand the client its data and its set-math function.

**Files:**
- Modify: `src/worker.js` — `CLIENT_SCRIPT` header (~line 693), `page()` (~line 1018), permalink route (~line 1200), home route (~line 1229)
- Test: `test.mjs` — mock KV `list` counter, plus a new section

**Interfaces:**
- Consumes: `computePool` from Task 1
- Produces: in-browser globals `CHOOSERS` (`Array<{slug, name, kind, type}>`) and `computePool` (function), both available to Task 4. Adds `page()` option `choosers`.

- [ ] **Step 1: Write the failing tests**

First instrument the mock KV in `test.mjs` so the gating is observable. Add a counter next to `const kv = new Map();`:

```js
const kv = new Map();
const counterState = new Map();
let kvListCalls = 0;
```

and increment it in the mock's `list`:

```js
    async list({ prefix }) {
      kvListCalls++;
      const keys = [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, cursor: "", list_complete: true };
    },
```

Then add a new section immediately before the `/* report */` block:

```js
/* 10. manifest inlining -------------------------------------------- */
const rHome2 = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
const home2 = await rHome2.text();
check("home leaves no __CHOOSERS__ placeholder", !home2.includes("__CHOOSERS__"));
check("home leaves no __POOL_FN__ placeholder", !home2.includes("__POOL_FN__"));
check("home leaves no __LISTS__ placeholder", !home2.includes("__LISTS__"));
check("home manifest includes a user chooser", home2.includes('"random-dinosaur"'));
check("home inlines computePool source", home2.includes("function computePool(manifest, state)"));

const rMeta2 = await worker.fetch(req("/c/random", { headers: { accept: "text/html" } }), env, ctx);
const meta2 = await rMeta2.text();
check("/c/random manifest includes a user chooser", meta2.includes('"random-dinosaur"'));
check("/c/random inlines computePool source", meta2.includes("function computePool(manifest, state)"));

/* the extra KV list is gated on the meta slug */
const beforeOrdinary = kvListCalls;
await worker.fetch(req("/c/animal", { headers: { accept: "text/html" } }), env, ctx);
check("ordinary permalink does not list KV", kvListCalls === beforeOrdinary, kvListCalls - beforeOrdinary);
const beforeMetaCall = kvListCalls;
await worker.fetch(req("/c/random", { headers: { accept: "text/html" } }), env, ctx);
check("meta permalink lists KV once", kvListCalls === beforeMetaCall + 1, kvListCalls - beforeMetaCall);

/* the shipped script parses -- catches typos in a string nothing else checks */
const scriptMatch = home2.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
check("client script found in page", !!scriptMatch);
let parseResult = "no script";
if (scriptMatch) {
  try {
    new Function(scriptMatch[1]);
    parseResult = true;
  } catch (e) {
    parseResult = e.message;
  }
}
check("shipped client script parses", parseResult === true, parseResult);

/* a "$&" in a chooser name must not corrupt the manifest */
const cookieD = await freshCookie();
await worker.fetch(
  postJson("/api/create", { name: "dollar $& sign" }, { cookie: "rc_uid=" + cookieD }),
  env,
  ctx
);
const rHome3 = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
const home3 = await rHome3.text();
const script3 = home3.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
let parse3 = "no script";
if (script3) {
  try {
    new Function(script3[1]);
    parse3 = true;
  } catch (e) {
    parse3 = e.message;
  }
}
check("manifest survives a $& in a chooser name", parse3 === true, parse3);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: exits 1. `home leaves no __CHOOSERS__ placeholder` FAILs, `home inlines computePool source` FAILs, `meta permalink lists KV once` FAILs with detail `0`.

- [ ] **Step 3a: Declare the client-side globals**

In `CLIENT_SCRIPT`, replace the single `var LISTS = __LISTS__;` line (~line 693) with:

```js
  var LISTS = __LISTS__;
  var CHOOSERS = __CHOOSERS__;
  __POOL_FN__
```

`__POOL_FN__` sits on its own line and is replaced by the full `function computePool(...) {...}` declaration.

- [ ] **Step 3b: Add a manifest helper**

In `src/worker.js`, immediately after `computePool` from Task 1:

```js
/* The shape the client needs to reason about a chooser. */
function manifestEntry(c) {
  return { slug: c.slug, name: c.name, kind: c.kind, type: c.type };
}

function buildManifest(users) {
  return BUILTINS.map(manifestEntry).concat(users.map(manifestEntry));
}
```

- [ ] **Step 3c: Perform the substitutions in `page()`**

Replace line 1018:

```js
<script>${CLIENT_SCRIPT.replace("__LISTS__", listsJson)}</script>
```

with:

```js
<script>${CLIENT_SCRIPT
  .replace("__LISTS__", function () { return listsJson; })
  .replace("__CHOOSERS__", function () { return JSON.stringify(opts.choosers || []); })
  .replace("__POOL_FN__", function () { return computePool.toString(); })}</script>
```

The function form is required: chooser names are visitor-supplied, and a literal `$&` in a replacement string is a backreference. `listsJson` moves to the function form for the same reason — the built-in lists are static today, but the hazard is identical and the fix is free.

- [ ] **Step 3d: Pass the manifest from the home route**

In the home route (~line 1229), the `users` list is already in hand. Add `choosers` to the `page()` call:

```js
        return html(
          page({
            title: ...,
            ...
            cards,
            choosers: buildManifest(users),
            ...
          }),
```

- [ ] **Step 3e: Pass the manifest from the permalink route, gated**

In the permalink route (~line 1200), after `const counts = ...`:

```js
        // Only the meta chooser needs the whole shelf; every other
        // permalink stays at its current single-lookup cost.
        const choosers =
          rec.slug === "random" ? buildManifest(await listUserChoosers(env)) : [];
```

and add `choosers,` to that route's `page()` call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all checks pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/worker.js test.mjs
git commit -m "feat: inline the chooser manifest and computePool into the page

The client needs the shelf and the pool set math. Both ride the
existing placeholder mechanism that already hands built-in item lists
to the browser, so there is still no build step and no fetch on the
press path -- the server already holds this data at render time.

Substitutions use the function form of String.replace because chooser
names are visitor-supplied and a literal \$& in a replacement string is
a backreference, which would corrupt the emitted script.

The permalink route's extra KV list is gated on the meta slug so
ordinary permalinks keep their single-lookup cost; a test asserts it."
```

---

### Task 4: Client wiring — selector, persistence, and press dispatch

The browser half. Per the spec this ships covered by manual testing, not automated: the DOM dispatch is unreachable from `test.mjs` without adding a dependency, which CI forbids. The parse guard from Task 3 still applies.

**Files:**
- Modify: `src/worker.js` — `pressNumber` (~line 756), `bindCard` (~line 857), plus new functions in `CLIENT_SCRIPT`
- Modify: `README.md`

**Interfaces:**
- Consumes: `CHOOSERS` and `computePool` from Task 3; `.pool-builtins`, `.pool-users`, `.pool-list`, `.via` from Task 2
- Produces: end-user behavior; nothing downstream depends on it

- [ ] **Step 1: Guard `pressNumber` against absent bounds inputs**

The meta card has no `.num-min`/`.num-max`. `pressNumber` already falls back to 1 and 100 for unparseable values, but writes back to `input.value`, which throws on `null`. This is the only edit to existing working code — keep it minimal.

In `CLIENT_SCRIPT`, change `clamped` and the swap that follows:

```js
  function pressNumber(card){
    var minIn = card.querySelector(".num-min");
    var maxIn = card.querySelector(".num-max");
    var CAP = 1e12;
    function clamped(input, fallback){
      // The meta card borrows this function but has no bounds inputs,
      // so an absent input means "use the default".
      if (!input) return fallback;
      var v = parseFloat(input.value);
      if (!isFinite(v)) v = fallback;
      v = Math.round(v);
      if (v > CAP) v = CAP;
      if (v < -CAP) v = -CAP;
      input.value = v;
      return v;
    }
    var a = clamped(minIn, 1), b = clamped(maxIn, 100);
    if (a > b) {
      var t = a; a = b; b = t;
      if (minIn) minIn.value = a;
      if (maxIn) maxIn.value = b;
    }
    textResult(card, String(randInt(a, b)), true);
  }
```

- [ ] **Step 2: Add pool persistence**

In `CLIENT_SCRIPT`, immediately above `function bindCard(card){`:

```js
  /* meta chooser: pool preferences --------------------------------- */
  var POOL_KEY = "rc_pool";

  function defaultPool(){ return { builtins: true, users: true, off: [] }; }

  function loadPool(){
    try {
      var raw = localStorage.getItem(POOL_KEY);
      if (!raw) return defaultPool();
      var s = JSON.parse(raw);
      if (!s || typeof s !== "object") return defaultPool();
      var known = {};
      for (var i = 0; i < CHOOSERS.length; i++) known[CHOOSERS[i].slug] = 1;
      var off = [];
      if (Object.prototype.toString.call(s.off) === "[object Array]") {
        for (var k = 0; k < s.off.length; k++) {
          if (known[s.off[k]]) off.push(s.off[k]);
        }
      }
      return { builtins: s.builtins !== false, users: s.users !== false, off: off };
    } catch (e) {
      return defaultPool();
    }
  }

  function savePool(state){
    try { localStorage.setItem(POOL_KEY, JSON.stringify(state)); } catch (e) {}
  }
```

- [ ] **Step 3: Add the meta card binding**

Immediately after `savePool`:

```js
  function bindMeta(card){
    var state = loadPool();
    var bEl = card.querySelector(".pool-builtins");
    var uEl = card.querySelector(".pool-users");
    var listEl = card.querySelector(".pool-list");
    var viaEl = card.querySelector(".via");
    var btn = card.querySelector("button.press");

    for (var i = 0; i < CHOOSERS.length; i++) {
      var c = CHOOSERS[i];
      if (c.slug === "random") continue;
      var lab = document.createElement("label");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.setAttribute("data-slug", c.slug);
      box.checked = state.off.indexOf(c.slug) === -1;
      lab.appendChild(box);
      lab.appendChild(document.createTextNode(" " + c.name));
      listEl.appendChild(lab);
    }

    bEl.checked = state.builtins;
    uEl.checked = state.users;

    function refresh(){
      var pool = computePool(CHOOSERS, state);
      btn.disabled = pool.length === 0;
      if (pool.length === 0) viaEl.textContent = "nothing selected";
      else if (viaEl.textContent === "nothing selected") viaEl.textContent = "";
    }

    function sync(){
      state.builtins = bEl.checked;
      state.users = uEl.checked;
      var off = [];
      var boxes = listEl.querySelectorAll("input[data-slug]");
      for (var j = 0; j < boxes.length; j++) {
        if (!boxes[j].checked) off.push(boxes[j].getAttribute("data-slug"));
      }
      state.off = off;
      savePool(state);
      refresh();
    }

    bEl.addEventListener("change", sync);
    uEl.addEventListener("change", sync);
    listEl.addEventListener("change", sync);
    refresh();

    btn.addEventListener("click", function(){
      showErr(card, "");
      var pool = computePool(CHOOSERS, state);
      if (!pool.length) return;
      var chosen = pick(pool);
      viaEl.textContent = "via " + chosen.name;
      if (chosen.kind === "builtin") {
        if (chosen.type === "number") pressNumber(card);
        else if (chosen.type === "color") pressColor(card);
        else if (chosen.type === "shape") pressShape(card);
        else pressList(card, chosen.slug);
      } else {
        pressKv(card, chosen.slug, btn);
      }
    });
  }
```

- [ ] **Step 4: Route meta cards to `bindMeta`**

In `bindCard`, add the early return after the attributes are read:

```js
  function bindCard(card){
    var btn = card.querySelector("button.press");
    if (!btn) return;
    var slug = card.getAttribute("data-slug");
    var kind = card.getAttribute("data-kind");
    var type = card.getAttribute("data-type");
    if (type === "meta") { bindMeta(card); return; }
    btn.addEventListener("click", function(){
```

- [ ] **Step 5: Run the automated tests**

Run: `npm test`
Expected: all checks pass, exit 0 — in particular `shipped client script parses`, which now covers everything added above.

- [ ] **Step 6: Manual verification**

Run: `npx wrangler dev` and open the printed URL. Walk this list, which is the coverage the harness cannot provide:

1. Press `random random` ~15 times. Confirm the `via` line names a chooser each time and the result matches that chooser's native shape — a swatch for `color`, a canvas polygon for `shape`, a plain word for `animal`.
2. Confirm `via` never says `random random`.
3. Uncheck **built-ins**. Press several times; only user choosers appear. Re-check it.
4. Uncheck **user-made**. Press several times; only built-ins appear.
5. Uncheck both. Confirm the Press button is disabled and `via` reads `nothing selected`.
6. Expand **customize**, uncheck `color` and `shape`. Press ~10 times; neither appears.
7. Reload. Confirm `color` and `shape` are still unchecked.
8. In devtools, run `localStorage.setItem("rc_pool", "not json")` and reload. Confirm the card falls back to everything-on rather than breaking.
9. Create a new chooser via the form, reload, expand **customize**. Confirm the new chooser is present **and checked** — this is the exclusion-list behavior.
10. Land on a user chooser, then visit that chooser's own card. Confirm its press count includes the indirect press.
11. Visit `/c/random` directly. Confirm the card works standalone with the full pool, not just itself.

- [ ] **Step 7: Update the README**

Add to `README.md` after the built-in chooser table:

```markdown
The sixth built-in, `random`, is a meta chooser: it picks one of the others and
delegates, so the result renders in whatever form that chooser produces -- a
swatch, a canvas, or a server pick. Which choosers it may land on is set per
visitor with two group toggles plus a per-chooser `customize` list, stored in
`localStorage` under `rc_pool`.

Preferences are stored as *exclusions* (`{builtins, users, off: [slug]}`), not
inclusions, so choosers created after a visitor sets preferences are in the pool
by default rather than silently absent.

Landing on a user chooser calls the same `POST /api/pick/:slug` as a direct
press, so indirect presses count. `random` itself has no press counter, matching
the other built-ins.
```

Also update the built-in table's intro line, which currently reads "Five choosers ship in the worker", to "Six choosers ship in the worker", and add the `random` row:

```markdown
| `random` | picks one of the other choosers, then a result from it; pool configurable per visitor |
```

Note the sentence after the table — "run entirely in the browser — no server calls, no counters" — is no longer true of `random`, which calls the server when it lands on a user chooser. Amend it to note the exception.

- [ ] **Step 8: Commit**

```bash
git add src/worker.js README.md
git commit -m "feat: random random client wiring

Pool selector, localStorage persistence, and press dispatch. Landing on
a built-in calls that built-in's existing press function against the
meta card, so swatches and canvases render with no new rendering code;
landing on a user chooser goes through pressKv and counts as a press.

pressNumber gains a guard for absent bounds inputs -- the meta card
borrows it but has no min/max fields, and the existing fallback path
wrote back to input.value. That is the only change to existing
behavior, and the number card's own path is untouched.

The DOM dispatch has no automated coverage: reaching it needs jsdom,
and CI runs with no install step. The shipped-script parse guard and
the manual checklist in the plan cover it instead."
```

---

## Follow-on, not in this plan

**Random Day** — a `type: "list"` built-in with the seven weekday names, same shape as `animal`. It becomes a candidate in the `random` pool automatically. Worth its own small change once this lands; note that adding it means updating the `six built-ins` count check in `test.mjs` to seven.
