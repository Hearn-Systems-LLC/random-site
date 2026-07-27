import worker, { BUILTINS, Counters, slugify, computePool } from "./src/worker.js";

/* ------------------------------------------------------------------ *
 * Mocks. No network, no wrangler: KV is a Map, the Counters DO is a
 * stub honoring the string-URL + init-method calling convention the
 * worker uses, and the AI binding switches on model name. No
 * TURNSTILE_SECRET is set, which exercises the documented bypass.
 * ------------------------------------------------------------------ */

const kv = new Map();
const counterState = new Map();
let kvListCalls = 0;

const env = {
  COOKIE_SECRET: "test-secret",
  CHOOSERS: {
    async get(k, o) {
      const v = kv.get(k);
      if (v === undefined) return null;
      return o && o.type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      kv.set(k, String(v));
    },
    async delete(k) {
      kv.delete(k);
    },
    async list({ prefix }) {
      kvListCalls++;
      const keys = [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, cursor: "", list_complete: true };
    },
  },
  COUNTERS: {
    idFromName: () => ({}),
    get: () => ({
      async fetch(req, init) {
        const u = new URL(typeof req === "string" ? req : req.url);
        const method = (init && init.method) || (typeof req !== "string" && req.method) || "GET";
        const body = init && init.body ? JSON.parse(init.body) : null;
        if (method === "POST" && u.pathname === "/hit") {
          const key = "p:" + body.slug;
          const count = (counterState.get(key) || 0) + 1;
          counterState.set(key, count);
          return Response.json({ slug: body.slug, count });
        }
        if (method === "POST" && u.pathname === "/counts") {
          const counts = {};
          for (const s of body.slugs || []) counts[s] = counterState.get("p:" + s) || 0;
          return Response.json({ counts });
        }
        const slug = u.searchParams.get("slug");
        return Response.json({ slug, count: counterState.get("p:" + slug) || 0 });
      },
    }),
  },
  AI: {
    // 120b -> gpt-oss shape (choices only), a JSON array of 10 items.
    // 20b  -> llama-ish string response, {"allow":false,...} when the
    //         chooser name contains "blocked".
    async run(model, opts) {
      const user = opts.messages[1].content;
      if (model.includes("120b")) {
        genCalls++;
        const items =
          genCalls === 1
            ? [
                "Raptor", "raptor ", "", "T-Rex", "Stegosaurus",
                "Triceratops", "Ankylosaurus", "Brontosaurus", "Pterodactyl",
                "x".repeat(60),
              ]
            : Array.from({ length: 10 }, (_, i) => "gen-" + genCalls + "-item-" + i);
        return { choices: [{ message: { content: JSON.stringify(items) } }] };
      }
      const blocked = /blocked/i.test(user);
      return {
        response: JSON.stringify(
          blocked ? { allow: false, reason: "mock says no" } : { allow: true }
        ),
      };
    },
  },
};

let genCalls = 0;
const pending = [];
const ctx = {
  waitUntil(p) {
    pending.push(p);
  },
};

function req(path, init = {}) {
  return new Request("https://random.oddspark.dev" + path, init);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}

function postJson(path, obj, headers = {}) {
  return req(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(obj),
  });
}

// Grab a freshly minted signed cookie off an HTML page view.
async function freshCookie() {
  const r = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
  const sc = r.headers.get("set-cookie") || "";
  const m = sc.match(/rc_uid=([^;]+)/);
  return m ? m[1] : null;
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const today = new Date().toISOString().slice(0, 10);

/* 1. Built-in table integrity -------------------------------------- */
check("six built-ins", BUILTINS.length === 6, BUILTINS.map((b) => b.slug).join(","));
check(
  "built-in slugs",
  ["number", "color", "shape", "animal", "simpsons-character", "random"].every((s) =>
    BUILTINS.some((b) => b.slug === s)
  )
);
const animal = BUILTINS.find((b) => b.slug === "animal");
const simpsons = BUILTINS.find((b) => b.slug === "simpsons-character");
check("animal list >= 48 items", animal.items.length >= 48, animal.items.length);
check("simpsons list >= 48 items", simpsons.items.length >= 48, simpsons.items.length);

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
check("missing state defaults to everything on", computePool(MANIFEST).length === 4);

/* 2. slugify + collision suffix ------------------------------------ */
check("slugify basic", slugify("Hello, World!!") === "hello-world", slugify("Hello, World!!"));
check("slugify collapses and trims", slugify("--a  b--") === "a-b", slugify("--a  b--"));
check("slugify caps at 40 chars", slugify("x".repeat(80)).length <= 40);
check("slugify empty falls back", slugify("!!!") === "chooser", slugify("!!!"));

/* 3. Create success ------------------------------------------------- */
const cookie1 = await freshCookie();
check("homepage issues a signed cookie", /^[0-9a-f]{32}\.[0-9a-f]{64}$/.test(cookie1 || ""));

const rCreate = await worker.fetch(
  postJson("/api/create", { name: "random dinosaur" }, { cookie: "rc_uid=" + cookie1 }),
  env,
  ctx
);
const created = await rCreate.json();
check("create returns 200", rCreate.status === 200, rCreate.status);
check("slug is slugified name", created.slug === "random-dinosaur", created.slug);

const rec = kv.has("c:random-dinosaur") ? JSON.parse(kv.get("c:random-dinosaur")) : null;
check("KV record stored", !!rec);
check("record shape", !!(rec && rec.kind === "user" && rec.name === "random dinosaur" && Array.isArray(rec.items)));
check("record listDay is today", rec && rec.listDay === today, rec && rec.listDay);
check("mock 10 sanitized to 8 (dedupe/empty dropped)", rec && rec.items.length === 8, rec && rec.items.length);
check(
  "items deduped case-insensitively",
  rec && new Set(rec.items.map((i) => i.toLowerCase())).size === rec.items.length
);
check("items capped at 48 chars", rec && rec.items.every((i) => i.length > 0 && i.length <= 48));
check("rate slot consumed after success", kv.has("rl:" + today + ":" + (await sha256Hex(cookie1))));

/* slug collision: same name from a different cookie gets a suffix --- */
const cookie2 = await freshCookie();
const rDup = await worker.fetch(
  postJson("/api/create", { name: "random dinosaur" }, { cookie: "rc_uid=" + cookie2 }),
  env,
  ctx
);
const dup = await rDup.json();
check("collision create returns 200", rDup.status === 200, rDup.status);
check("collision slug gets -<4 hex> suffix", /^random-dinosaur-[0-9a-f]{4}$/.test(dup.slug || ""), dup.slug);

/* 4. Screening rejection ------------------------------------------- */
const cookie3 = await freshCookie();
const kvSizeBefore = kv.size;
const rBlocked = await worker.fetch(
  postJson("/api/create", { name: "blocked thing" }, { cookie: "rc_uid=" + cookie3 }),
  env,
  ctx
);
const blocked = await rBlocked.json();
check("rejected create returns 403", rBlocked.status === 403, rBlocked.status);
check("rejection carries the reason", blocked.error === "mock says no", blocked.error);
check("rejection stores nothing", kv.size === kvSizeBefore, kv.size + " vs " + kvSizeBefore);
check("rejection does not consume rate slot", !kv.has("rl:" + today + ":" + (await sha256Hex(cookie3))));

// ...and the same cookie can still create something allowed afterwards
const rAfter = await worker.fetch(
  postJson("/api/create", { name: "garden birds" }, { cookie: "rc_uid=" + cookie3 }),
  env,
  ctx
);
check("allowed create after rejection succeeds", rAfter.status === 200, rAfter.status);

/* 5. Second create same day -> 429 --------------------------------- */
const rAgain = await worker.fetch(
  postJson("/api/create", { name: "cheeses" }, { cookie: "rc_uid=" + cookie1 }),
  env,
  ctx
);
const again = await rAgain.json();
check("second create same day returns 429", rAgain.status === 429, rAgain.status);
check(
  "429 message",
  again.error === "one new chooser per day; come back tomorrow",
  again.error
);

/* 6. Pre-seeded rate-limit key -> 429 ------------------------------- */
const cookie4 = await freshCookie();
kv.set("rl:" + today + ":" + (await sha256Hex(cookie4)), "1");
const rPre = await worker.fetch(
  postJson("/api/create", { name: "cheeses" }, { cookie: "rc_uid=" + cookie4 }),
  env,
  ctx
);
check("existing rl key returns 429", rPre.status === 429, rPre.status);

/* 6b. No cookie -> 400 ---------------------------------------------- */
const rNoCookie = await worker.fetch(postJson("/api/create", { name: "cheeses" }), env, ctx);
check("create without cookie returns 400", rNoCookie.status === 400, rNoCookie.status);

/* 7. Pick returns a list member and increments the DO --------------- */
const rPick1 = await worker.fetch(req("/api/pick/random-dinosaur", { method: "POST" }), env, ctx);
const pick1 = await rPick1.json();
check("pick returns 200", rPick1.status === 200, rPick1.status);
check("pick item is a list member", rec.items.includes(pick1.item), pick1.item);
check("pick returns count 1", pick1.count === 1, pick1.count);
check("pick echoes slug and name", pick1.slug === "random-dinosaur" && pick1.name === "random dinosaur");

const rPick2 = await worker.fetch(req("/api/pick/random-dinosaur", { method: "POST" }), env, ctx);
const pick2 = await rPick2.json();
check("second pick increments counter", pick2.count === 2, pick2.count);

/* 8. Stale listDay: old item now, regeneration in waitUntil --------- */
const staleKey = "c:garden-birds";
const staleRec = JSON.parse(kv.get(staleKey));
staleRec.listDay = "2000-01-01";
kv.set(staleKey, JSON.stringify(staleRec));
const genCallsBefore = genCalls;
const pendingBefore = pending.length;

const rStale = await worker.fetch(req("/api/pick/garden-birds", { method: "POST" }), env, ctx);
const stalePick = await rStale.json();
check("stale pick returns 200", rStale.status === 200);
check("stale pick returns an item from the OLD list", staleRec.items.includes(stalePick.item), stalePick.item);
check("stale pick scheduled a background refresh", pending.length === pendingBefore + 1);

await Promise.all(pending.splice(pendingBefore));
const refreshed = JSON.parse(kv.get(staleKey));
check("waitUntil refreshed listDay to today", refreshed.listDay === today, refreshed.listDay);
check("waitUntil replaced the items", genCalls === genCallsBefore + 1 && refreshed.items[0].startsWith("gen-" + genCalls + "-"), refreshed.items[0]);
check("old list was not blanked on the way", refreshed.items.length >= 8);

/* 9. Unknown slug pick -> 404 JSON ---------------------------------- */
const rNoPick = await worker.fetch(req("/api/pick/nope", { method: "POST" }), env, ctx);
check("unknown slug pick returns 404", rNoPick.status === 404, rNoPick.status);
check("404 pick is JSON", (rNoPick.headers.get("content-type") || "").includes("application/json"));

/* 10. Permalinks ----------------------------------------------------- */
const rPerm = await worker.fetch(req("/c/random-dinosaur", { headers: { accept: "text/html" } }), env, ctx);
const permHtml = await rPerm.text();
check("permalink returns 200 HTML", rPerm.status === 200 && permHtml.startsWith("<!doctype html>"));
check("permalink names the chooser", permHtml.includes("random dinosaur"));
check("permalink shows merged count", permHtml.includes("2 presses"));
check("permalink has no create card", !permHtml.includes('id="create-card"'));

const rBuiltinPerm = await worker.fetch(req("/c/animal", { headers: { accept: "text/html" } }), env, ctx);
check("built-in permalink returns 200", rBuiltinPerm.status === 200, rBuiltinPerm.status);

const r404 = await worker.fetch(req("/c/nope", { headers: { accept: "text/html" } }), env, ctx);
check("unknown permalink returns 404 page", r404.status === 404 && (r404.headers.get("content-type") || "").includes("text/html"));

/* 11. Homepage lists the created chooser ----------------------------- */
const rHome = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
const home = await rHome.text();
check("homepage is HTML", (rHome.headers.get("content-type") || "").includes("text/html"));
check("homepage contains created chooser", home.includes("random dinosaur"));
check("homepage contains a built-in", home.includes("simpsons character"));
check("homepage has the create card", home.includes('id="create-card"'));
check("client script honors the no-template-literal invariant", !home.includes("`${") && !home.includes("var LISTS = __LISTS__"));

/* 12. curl gets text/plain ------------------------------------------- */
const rCurl = await worker.fetch(req("/", { headers: { "user-agent": "curl/8.4.0", accept: "*/*" } }), env, ctx);
const curlTxt = await rCurl.text();
check("curl gets text/plain", (rCurl.headers.get("content-type") || "").includes("text/plain"));
check("text rendering lists choosers", curlTxt.includes("random-dinosaur") && curlTxt.includes("BUILT-IN"));

/* 13. /api/choosers --------------------------------------------------- */
const rList = await worker.fetch(req("/api/choosers"), env, ctx);
const list = await rList.json();
check("/api/choosers returns an array", rList.status === 200 && Array.isArray(list));
check(
  "/api/choosers marks built-ins",
  list.filter((c) => c.kind === "builtin").length === 6
);
check(
  "/api/choosers includes user choosers",
  list.some((c) => c.slug === "random-dinosaur" && c.kind === "user" && c.name === "random dinosaur")
);
check(
  "/api/choosers shape",
  list.every((c) => typeof c.slug === "string" && typeof c.name === "string" && typeof c.kind === "string")
);

/* 14. random random card -------------------------------------------- */
const meta = BUILTINS.find((b) => b.slug === "random");
check("random is a meta built-in", !!meta && meta.type === "meta" && meta.kind === "builtin");
check("random has no items list", !!meta && meta.items === undefined);

const rMeta = await worker.fetch(req("/c/random", { headers: { accept: "text/html" } }), env, ctx);
const metaPageHtml = await rMeta.text();
check("/c/random returns 200", rMeta.status === 200, rMeta.status);
// Extract just the random card markup to scope assertions to the card itself
const cardStart = metaPageHtml.indexOf('<article class="card" data-slug="random"');
check("meta card markup located", cardStart !== -1);
const cardEnd = metaPageHtml.indexOf('</article>', cardStart) + '</article>'.length;
const metaHtml = metaPageHtml.substring(cardStart, cardEnd);
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

/* 15. manifest inlining -------------------------------------------- */
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
check(
  "manifest survives a $& in a chooser name (verbatim)",
  home3.includes('"dollar $& sign"') && !home3.includes("__CHOOSERS__")
);

/* a chooser name must not be able to close the <script> block early -- */
const cookieX = await freshCookie();
await worker.fetch(
  postJson("/api/create", { name: "x </script> y" }, { cookie: "rc_uid=" + cookieX }),
  env,
  ctx
);
const rHomeX = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
const homeX = await rHomeX.text();
check(
  "chooser name cannot break out of the script block",
  homeX.includes("\\u003c/script>") && !homeX.includes('"name":"x </script> y"')
);

/* 16. Hearn. builder's credit ---------------------------------------- */
const rCredit = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
const creditHtml = await rCredit.text();
const creditStart = creditHtml.indexOf('<a class="built"');
check("builder's credit present", creditStart !== -1);
const creditEnd = creditHtml.indexOf("</a>", creditStart) + "</a>".length;
const credit = creditHtml.slice(creditStart, creditEnd);
check("credit links to hearn.systems", credit.includes('href="https://hearn.systems"'), credit.slice(0, 60));
check("credit carries rel=noopener", credit.includes('rel="noopener"'));
check("mark is labelled for screen readers", credit.includes('aria-label="Hearn."'));
check("mark is outlined paths, not live text", credit.includes("<path") && !credit.includes("<text"));
check("mark inherits colour but keeps brand oxide", credit.includes('fill="currentColor"') && credit.includes("#B4502E"));
// The 404 page has no footer, so it must not carry the credit either.
const rCredit404 = await worker.fetch(req("/c/nope", { headers: { accept: "text/html" } }), env, ctx);
check("404 page has no builder's credit", !(await rCredit404.text()).includes('class="built"'));

/* report -------------------------------------------------------------- */
let fails = 0;
for (const r of results) {
  if (!r.ok) fails++;
  console.log((r.ok ? "  ok   " : "  FAIL ") + r.name + (r.detail !== undefined ? "   [" + r.detail + "]" : ""));
}
console.log("\n" + (results.length - fails) + "/" + results.length + " passed");

console.log("\n--- sample text output (what curl sees) ---\n");
console.log(curlTxt);

process.exit(fails ? 1 : 0);
