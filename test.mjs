import { readFileSync } from "node:fs";
import worker, {
  BUILTINS,
  Counters,
  SHAPE_COLORS,
  slugify,
  computePool,
  builtinPick,
  derivePick,
  deriveDie,
  deriveItem,
  beaconRoundForTime,
  beaconPublishTime,
  awaitBeaconRound,
  probeBeaconRound,
  beaconTiming,
  deriveFnsSrc,
} from "./src/worker.js";

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
    //         genCalls 1 returns a fixed dirty list for the sanitization
    //         assertions; setting genItems overrides the payload (used to
    //         push an oversized, dupe-laden list through the 200 cap).
    //         Every call is recorded in lastGenCall so the suite can
    //         assert on the request itself (model, max_tokens, prompt).
    // 20b  -> llama-ish string response, {"allow":false,...} when the
    //         chooser name contains "blocked".
    async run(model, opts) {
      const user = opts.messages[1].content;
      if (model.includes("120b")) {
        genCalls++;
        lastGenCall = { model: model, opts: opts };
        const items =
          genCalls === 1
            ? [
                "Raptor", "raptor ", "", "T-Rex", "Stegosaurus",
                "Triceratops", "Ankylosaurus", "Brontosaurus", "Pterodactyl",
                "x".repeat(60),
              ]
            : genItems !== null
              ? genItems
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
let genItems = null;
let lastGenCall = null;
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

/* Beacon stub. The ONLY network the worker may attempt under test is the
   drand beacon (Turnstile is bypassed because TURNSTILE_SECRET is unset);
   anything else throws, so a regression that adds a network call fails
   loudly. The stub models the probe-forward world: /public/latest answers
   beaconLatest, rounds <= beaconHorizon are served, rounds beyond 404 on
   first sight and "publish" on the next fetch (the press's poll). "down"
   simulates an unreachable beacon; a round in beaconHold 404s until
   released, which exercises the poll-timeout path. Poll and probe URLs
   carry cache-busting "?p=" queries, stripped here. */
const BEACON_PREFIX =
  "https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/";
let beaconMode = "healthy";
let beaconLatest = 0;
let beaconHorizon = 0;
const beaconAttempts = new Map();
const beaconHold = new Set();
const beaconRandomnessCache = new Map();
async function beaconRandomness(round) {
  if (!beaconRandomnessCache.has(round)) {
    beaconRandomnessCache.set(round, await sha256Hex("stub-beacon:" + round));
  }
  return beaconRandomnessCache.get(round);
}
// A freshly-seeded healthy beacon: latest L, horizon L+2, so a probe
// walks two 200s and commits L+3.
function seedBeacon(latest) {
  beaconLatest = latest;
  beaconHorizon = latest + 2;
  beaconAttempts.clear();
  beaconHold.clear();
}
globalThis.fetch = async (url) => {
  const u = String(url);
  if (!u.startsWith(BEACON_PREFIX)) throw new Error("unexpected fetch in tests: " + u);
  if (beaconMode === "down") throw new Error("beacon unreachable (stub)");
  const rest = u.slice(BEACON_PREFIX.length).split("?")[0];
  if (rest === "latest") {
    return Response.json({ round: beaconLatest, randomness: await beaconRandomness(beaconLatest), signature: "stub" });
  }
  const round = Number(rest);
  if (beaconHold.has(round)) return new Response("not found", { status: 404 });
  if (round <= beaconHorizon) {
    return Response.json({ round, randomness: await beaconRandomness(round), signature: "stub" });
  }
  // Beyond the horizon: 404 the first time, publish on the next fetch.
  const n = (beaconAttempts.get(round) || 0) + 1;
  beaconAttempts.set(round, n);
  if (n < 2) return new Response("not found", { status: 404 });
  seedBeacon(round); // the chain moved: latest = round, horizon = round + 2
  return Response.json({ round, randomness: await beaconRandomness(round), signature: "stub" });
};
seedBeacon(500000);

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
check("record carries no listDay", rec && !("listDay" in rec));
check("mock 10 sanitized to 8 (dedupe/empty dropped)", rec && rec.items.length === 8, rec && rec.items.length);
check(
  "items deduped case-insensitively",
  rec && new Set(rec.items.map((i) => i.toLowerCase())).size === rec.items.length
);
check("items capped at 48 chars", rec && rec.items.every((i) => i.length > 0 && i.length <= 48));
check("rate slot consumed after success", kv.has("rl:" + today + ":" + (await sha256Hex(cookie1))));

/* the generation request itself: model, budget, prompt --------------- */
check(
  "generation ran on the 120b model",
  lastGenCall && lastGenCall.model === "@cf/openai/gpt-oss-120b",
  lastGenCall && lastGenCall.model
);
check(
  "generation budget fits 200 items plus reasoning",
  lastGenCall && lastGenCall.opts.max_tokens === 16384,
  lastGenCall && lastGenCall.opts.max_tokens
);
check(
  "prompt asks for the complete list, up to 200",
  lastGenCall &&
    lastGenCall.opts.messages[0].content.includes("EVERY distinct item") &&
    lastGenCall.opts.messages[0].content.includes("up to 200"),
  lastGenCall && lastGenCall.opts.messages[0].content
);

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

/* 3b. Oversized model output is capped at 200, deduped first ---------- */
// 260 items: every 13th is one of three case-stable repeat labels, so the
// unique count (243) still exceeds the cap -- this exercises cap AND the
// dedupe that runs before it, in one create.
genItems = Array.from({ length: 260 }, (_, i) =>
  i % 13 === 0 ? "Cap-Item-" + (i % 3) : "big-item-" + i
);
const cookieBig = await freshCookie();
const rBig = await worker.fetch(
  postJson("/api/create", { name: "huge category" }, { cookie: "rc_uid=" + cookieBig }),
  env,
  ctx
);
genItems = null;
check("big create returns 200", rBig.status === 200, rBig.status);
const bigRec = JSON.parse(kv.get("c:huge-category"));
check("list capped at 200 items", bigRec && bigRec.items.length === 200, bigRec && bigRec.items.length);
check(
  "cap output stays deduped case-insensitively",
  bigRec && new Set(bigRec.items.map((i) => i.toLowerCase())).size === bigRec.items.length
);
check(
  "cap keeps the head of the list in order",
  bigRec && bigRec.items[0] === "Cap-Item-0" && bigRec.items[1] === "big-item-1",
  bigRec && bigRec.items.slice(0, 2).join(",")
);

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

/* 8. Static lists: a press NEVER regenerates, whatever listDay says ---- */
// Pre-change records may still carry a stale listDay field; it must be
// ignored entirely -- no waitUntil, no AI list-generation call.
const staleKey = "c:garden-birds";
const staleRec = JSON.parse(kv.get(staleKey));
staleRec.listDay = "2000-01-01";
kv.set(staleKey, JSON.stringify(staleRec));
const genCallsBefore = genCalls;
const pendingBefore = pending.length;

const rStale = await worker.fetch(req("/api/pick/garden-birds", { method: "POST" }), env, ctx);
const stalePick = await rStale.json();
check("stale-listDay pick returns 200", rStale.status === 200);
check("stale-listDay pick returns an item from the SAME list", staleRec.items.includes(stalePick.item), stalePick.item);
check("stale listDay schedules no background work", pending.length === pendingBefore, pending.length);
check("stale listDay triggers no AI call", genCalls === genCallsBefore);
check("stale record is left byte-identical", kv.get(staleKey) === JSON.stringify(staleRec));

// Same guarantees for a record with no listDay at all.
delete staleRec.listDay;
kv.set(staleKey, JSON.stringify(staleRec));
const pendingBefore2 = pending.length;
const rNoDay = await worker.fetch(req("/api/pick/garden-birds", { method: "POST" }), env, ctx);
const noDayPick = await rNoDay.json();
check("absent-listDay pick returns 200", rNoDay.status === 200);
check("absent-listDay pick returns an item from the SAME list", staleRec.items.includes(noDayPick.item), noDayPick.item);
check("absent listDay schedules no background work", pending.length === pendingBefore2, pending.length);
check("absent listDay triggers no AI call", genCalls === genCallsBefore);

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
check("meta text advertises its curl press", metaTxt.includes("/api/pick/random"));

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

/* 16. meta chooser leads the shelf ----------------------------------- */
check("random is the first built-in", BUILTINS[0].slug === "random", BUILTINS[0].slug);
const rOrder = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
const orderHtml = await rOrder.text();
const slugOrder = [...orderHtml.matchAll(/<article class="card" data-slug="([^"]+)"/g)].map((m) => m[1]);
check("meta card renders before every other card", slugOrder[0] === "random", slugOrder.slice(0, 3).join(","));
check("meta card is not repeated", slugOrder.filter((s) => s === "random").length === 1);
// Full-row span and the number-input scoping are CSS-only, so assert the rules
// exist rather than their effect. The unscoped `.ctl input` rule sized the
// pool checkboxes to 92px, so guard against it coming back.
check("meta card spans the full grid row", orderHtml.includes('.card[data-type="meta"]{grid-column:1 / -1}'));
check("number-input width is scoped to number inputs", orderHtml.includes('.ctl input[type="number"]{'));
check("no unscoped .ctl input width rule", !/\.ctl input\{/.test(orderHtml));

/* 17. Hearn. builder's credit ---------------------------------------- */
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

/* 18. press counters address the card by slug ------------------------ */
const rCount = await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx);
const countHtml = await rCount.text();
const countScript = countHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];

// The meta chooser renders another chooser's result in its own card, so a
// counter lookup scoped to the pressed card silently updates nothing.
check("no card-scoped counter lookup", !countScript.includes('card.querySelector(".count")'));
check("counter updated by slug", countScript.includes("setCount(slug, r.j.count)"));

// Pull setCount out of the shipped script and run it against a stub DOM, so
// the test exercises the same source the browser runs. Brace matching is
// enough here: setCount's body holds no braces inside string literals.
function sliceFn(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}
const setCountSrc = sliceFn(countScript, "setCount");
check("setCount located in shipped script", !!setCountSrc);

function stubCard(slug, hasCount) {
  const count = hasCount ? { textContent: "" } : null;
  return { count, getAttribute: (a) => (a === "data-slug" ? slug : null), querySelector: () => count };
}
// "random" is the meta card: a built-in, so cardHtml gives it no .count div.
const stubCards = [stubCard("random", false), stubCard("random-food", true), stubCard("random-planet", true)];
const setCount = new Function("document", setCountSrc + "\nreturn setCount;")({
  querySelectorAll: () => stubCards,
});

setCount("random-food", 4);
check("landed-on card gets the new count", stubCards[1].count.textContent === "4 presses", stubCards[1].count.textContent);
check("other cards untouched", stubCards[2].count.textContent === "", stubCards[2].count.textContent);
setCount("random-planet", 1);
check("one press is singular", stubCards[2].count.textContent === "1 press", stubCards[2].count.textContent);
// The meta card has no counter to write to; landing on a built-in must not throw.
let noCountOk = true;
try { setCount("random", 9); } catch (e) { noCountOk = e.message; }
check("counterless card does not throw", noCountOk === true, noCountOk);
// On /c/<slug> the landed-on chooser's card is not rendered at all.
setCount("absent-from-page", 7);
check("slug absent from page is a no-op", stubCards[1].count.textContent === "4 presses", stubCards[1].count.textContent);

/* 19. text output tells the truth about where the meta pick runs ------ */
const curlHdr = { "user-agent": "curl/8.4.0", accept: "*/*" };
const metaCurlTxt = await (await worker.fetch(req("/c/random", { headers: curlHdr }), env, ctx)).text();
// "the pick happens in your browser" is true of every built-in but this one:
// landing on a visitor-made chooser is a real press against its counter.
check("meta text drops the browser-only claim", !metaCurlTxt.includes("the pick happens in your browser"));
check("meta text says a browser picks locally", metaCurlTxt.includes("the chooser is picked locally"));
check("meta text names the server hop", metaCurlTxt.includes("runs that pick on the server"));
check("meta text says it counts a press", metaCurlTxt.includes("counts as a press"));
check("meta text keeps its blurb", metaCurlTxt.includes("picks a chooser, then picks something from it"));
// Built-ins that really are browser-only must keep the plain wording.
const numTxt = await (await worker.fetch(req("/c/number", { headers: curlHdr }), env, ctx)).text();
check("ordinary built-in says it has no counter", numTxt.includes("built-in; no press counter"));
check("ordinary built-in advertises its curl press", numTxt.includes("curl -X POST") && numTxt.includes("/api/pick/number"));
check("ordinary built-in gains no server caveat", !numTxt.includes("runs on the server"));
// User choosers keep their curl instructions and gain no built-in wording.
const userTxt = await (await worker.fetch(req("/c/random-dinosaur", { headers: curlHdr }), env, ctx)).text();
check("user chooser keeps its curl line", userTxt.includes("curl -X POST"));
check("user chooser is not labelled built-in", !userTxt.includes("built-in;"));

/* 20. social preview image and card metadata -------------------------- */
const rPng = await worker.fetch(req("/social.png"), env, ctx);
check("/social.png returns 200", rPng.status === 200, rPng.status);
check("/social.png is image/png", (rPng.headers.get("content-type") || "") === "image/png", rPng.headers.get("content-type"));
check("/social.png is cached hard", (rPng.headers.get("cache-control") || "").includes("immutable"));
const png = new Uint8Array(await rPng.arrayBuffer());
// Verify real decoded bytes, not just that a route answers: PNG magic number
// then the IHDR width/height, which are big-endian uint32 at offsets 16 and 20.
check("PNG magic number intact", [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => png[i] === b), png.slice(0, 8).join(","));
const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
check("PNG is 1280 wide", dv.getUint32(16) === 1280, dv.getUint32(16));
check("PNG is 640 tall", dv.getUint32(20) === 640, dv.getUint32(20));
// GitHub rejects social previews over 1MB, and og: scrapers commonly cap at 5MB.
check("PNG is comfortably under 1MB", png.length < 1024 * 1024, png.length);
// The header checks above all live in the first 24 bytes, so they pass happily
// on a truncated image. This is the assertion that actually bites: what the
// worker serves must equal what is committed, catching truncation, corruption,
// and drift between assets/social.png and the inlined base64.
const sourcePng = new Uint8Array(readFileSync("assets/social.png"));
check(
  "served bytes match assets/social.png exactly",
  png.length === sourcePng.length && png.every((b, i) => b === sourcePng[i]),
  png.length + " served vs " + sourcePng.length + " on disk"
);

const ogHtml = await (await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx)).text();
check("og:image points at the absolute production URL", ogHtml.includes('property="og:image" content="https://random.oddspark.dev/social.png"'));
check("og:image declares its dimensions", ogHtml.includes('og:image:width" content="1280"') && ogHtml.includes('og:image:height" content="640"'));
check("og:image carries alt text", ogHtml.includes('property="og:image:alt"'));
check("twitter card upgraded to large image", ogHtml.includes('name="twitter:card" content="summary_large_image"'));
check("twitter:image set", ogHtml.includes('name="twitter:image" content="https://random.oddspark.dev/social.png"'));
check("no leftover summary-only card", !ogHtml.includes('content="summary"'));
check("JSON-LD carries the image", ogHtml.includes('"image":"https://random.oddspark.dev/social.png"'));
// Permalinks are shared far more than the root, so they need the card too.
const socialPermHtml = await (await worker.fetch(req("/c/random", { headers: { accept: "text/html" } }), env, ctx)).text();
check("permalink also carries og:image", socialPermHtml.includes('property="og:image" content="https://random.oddspark.dev/social.png"'));
check("permalink also gets the large card", socialPermHtml.includes('content="summary_large_image"'));

/* 21. built-ins and the meta chooser are pressable over the API ------- */
const B = (s) => BUILTINS.find((b) => b.slug === s);
const post = (s) => worker.fetch(req("/api/pick/" + s, { method: "POST" }), env, ctx);

// builtinPick is pure, so hammer it for range invariants rather than exact
// values. Bounds are where an off-by-one hides.
const nums = Array.from({ length: 400 }, () => Number(builtinPick(B("number"))));
check("number is always an integer", nums.every((n) => Number.isInteger(n)));
check("number never below 1", Math.min(...nums) >= 1, Math.min(...nums));
check("number never above 100", Math.max(...nums) <= 100, Math.max(...nums));
check("number reaches both bounds over 400 draws", nums.includes(1) && nums.includes(100));

const cols = Array.from({ length: 200 }, () => builtinPick(B("color")));
check("color is a 6-digit lowercase hex", cols.every((c) => /^#[0-9a-f]{6}$/.test(c)), cols[0]);
check("color varies", new Set(cols).size > 100, new Set(cols).size);

// shape: "a 7-sided polygon in #C9A227, filled". pressShape draws randInt(3,9)
// vertices, so the description must cover exactly that range and no wider.
const shapes = Array.from({ length: 600 }, () => builtinPick(B("shape")));
const shapeRe = /^an? (\d+)-sided polygon in (#[0-9A-F]{6}), (filled|outlined)$/;
check("shape description parses", shapes.every((s) => shapeRe.test(s)), shapes[0]);
const sides = shapes.map((s) => Number(s.match(shapeRe)[1]));
check("shape has at least 3 sides", Math.min(...sides) === 3, Math.min(...sides));
check("shape has at most 9 sides", Math.max(...sides) === 9, Math.max(...sides));
check(
  "shape only uses the shared palette",
  shapes.every((s) => SHAPE_COLORS.includes(s.match(shapeRe)[2])),
  [...new Set(shapes.map((s) => s.match(shapeRe)[2]))].filter((c) => !SHAPE_COLORS.includes(c)).join(",")
);
// English article agreement: only 8 takes "an", since it follows the spoken digit.
check(
  "shape article agrees with the digit",
  shapes.every((s) => (Number(s.match(shapeRe)[1]) === 8 ? s.startsWith("an ") : s.startsWith("a "))),
  shapes.find((s) => (Number(s.match(shapeRe)[1]) === 8 ? !s.startsWith("an ") : !s.startsWith("a "))) || "ok"
);
check("shape is sometimes filled and sometimes outlined",
  shapes.some((s) => s.endsWith("filled")) && shapes.some((s) => s.endsWith("outlined")));

const listPick = Array.from({ length: 100 }, () => builtinPick(B("animal")));
check("animal picks come from the list", listPick.every((a) => B("animal").items.includes(a)), listPick[0]);

// Over the API.
const rNum = await post("number");
const jNum = await rNum.json();
check("POST /api/pick/number returns 200", rNum.status === 200, rNum.status);
check("number pick has no counter", !("count" in jNum), JSON.stringify(jNum));
check("number pick echoes slug and name", jNum.slug === "number" && jNum.name === "number");
check("POST /api/pick/animal returns a list member", B("animal").items.includes((await (await post("animal")).json()).item));

// The meta chooser delegates and reports what it landed on.
const rMetaPick = await post("random");
const jMetaPick = await rMetaPick.json();
check("POST /api/pick/random returns 200", rMetaPick.status === 200, rMetaPick.status);
check("meta pick reports its own slug", jMetaPick.slug === "random", jMetaPick.slug);
check("meta pick names what it delegated to", !!(jMetaPick.via && jMetaPick.via.slug && jMetaPick.via.name), JSON.stringify(jMetaPick.via));
check("meta pick returns a non-empty item", typeof jMetaPick.item === "string" && jMetaPick.item.length > 0, jMetaPick.item);

// Never itself -- the recursion guard. computePool excludes type "meta", and
// this is the assertion that would catch it if that ever regressed.
const vias = [];
for (let i = 0; i < 60; i++) vias.push((await (await post("random")).json()).via.slug);
check("meta never delegates to itself over 60 presses", !vias.includes("random"), [...new Set(vias)].join(","));
check("meta reaches both built-ins and user choosers",
  vias.some((v) => BUILTINS.some((b) => b.slug === v)) && vias.some((v) => !BUILTINS.some((b) => b.slug === v)),
  [...new Set(vias)].join(","));

// Landing on a visitor-made chooser is a real press, exactly as in the browser.
let userLanding = null;
for (let i = 0; i < 80 && !userLanding; i++) {
  const j = await (await post("random")).json();
  if (!BUILTINS.some((b) => b.slug === j.via.slug)) userLanding = j;
}
check("meta eventually lands on a user chooser", !!userLanding);
if (userLanding) {
  check("indirect press returns that chooser's count", typeof userLanding.count === "number", userLanding.count);
  const direct = await (await post(userLanding.via.slug)).json();
  check("indirect press counted on the target, not the meta chooser",
    direct.count > userLanding.count, userLanding.count + " -> " + direct.count);
}
// Delegating to a built-in must not quietly invent a counter for it.
let builtinLanding = null;
for (let i = 0; i < 80 && !builtinLanding; i++) {
  const j = await (await post("random")).json();
  if (BUILTINS.some((b) => b.slug === j.via.slug)) builtinLanding = j;
}
check("meta eventually lands on a built-in", !!builtinLanding);
if (builtinLanding) {
  check("built-in delegation creates no counter", !("count" in builtinLanding), JSON.stringify(builtinLanding));
}
check("unknown slug still 404s", (await post("no-such-chooser-anywhere")).status === 404);

// The palette now has one definition, injected into the client the same way
// LISTS and CHOOSERS are.
const shapeHtml = await (await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx)).text();
check("no __SHAPE_COLORS__ placeholder left", !shapeHtml.includes("__SHAPE_COLORS__"));
check("palette inlined for the client", shapeHtml.includes(JSON.stringify(SHAPE_COLORS)), SHAPE_COLORS.join(","));
check("palette is not duplicated in the client script",
  (shapeHtml.match(/#8FA876/g) || []).length === 1, (shapeHtml.match(/#8FA876/g) || []).length);

/* 22. beacon round math ------------------------------------------------ */
check("round at genesis is 1", beaconRoundForTime(1692803367 * 1000) === 1);
check("round holds within its window", beaconRoundForTime(1692803367 * 1000 + 2999) === 1);
check("round advances at the window boundary", beaconRoundForTime((1692803367 + 3) * 1000) === 2);
check("round 1 publishes at genesis", beaconPublishTime(1) === 1692803367);
check("publish times are one period apart", beaconPublishTime(42) - beaconPublishTime(41) === 3);
// Commit contract: the committed round belongs to the 3s window starting
// now, so its nominal publish instant is never more than a period away.
const tNow = Date.now();
const tPub = beaconPublishTime(beaconRoundForTime(tNow)) * 1000;
check("committed round is the current window", tPub <= tNow + 1000 && tPub > tNow - 3000, (tPub - tNow) + "ms");
// The poll cadence the amended spec fixes: ~1s interval, ~18s cap.
check("poll cadence is ~1s with an ~18s cap", beaconTiming.intervalMs === 1000 && beaconTiming.capMs === 18000, JSON.stringify(beaconTiming));

/* 23. derivePick: vectors, bounds, uniformity --------------------------- */
// Vectors generated once from an independent implementation of the spec
// formula (seed = sha256hex(randomness + ":" + nonce + ":" + slug + ":"
// + drawIx), walked as eight uint32s with rejection sampling); they lock
// the algorithm against accidental drift.
const V_RAND = "f574f1b169399f705cc2cd7e2a222eca506cedb7a563109e26592f91cc1c2bba";
const V_NONCE = "0123456789abcdef";
check("derivePick vector: number", (await derivePick(V_RAND, V_NONCE, "number", 0, 100)) === 11, await derivePick(V_RAND, V_NONCE, "number", 0, 100));
check("derivePick vector: list", (await derivePick(V_RAND, V_NONCE, "animal", 0, 72)) === 70);
check("derivePick vector: meta pool", (await derivePick(V_RAND, V_NONCE, "random", 0, 5)) === 1);
check("derivePick vector: meta item draw", (await derivePick(V_RAND, V_NONCE, "animal", 1, 72)) === 24);
const varied = new Set();
for (let i = 0; i < 40; i++) varied.add(await derivePick(V_RAND, "nonce" + i, "number", 0, 100));
check("derivePick varies with the nonce", varied.size > 10, varied.size);
const buckets = new Array(10).fill(0);
for (let i = 0; i < 500; i++) buckets[await derivePick(V_RAND, "u" + i, "color", 0, 10)]++;
check("derivePick draws all 500", buckets.reduce((a, b) => a + b, 0) === 500);
check("derivePick is roughly uniform", buckets.every((c) => c > 20 && c < 90), buckets.join(","));
check("derivePick n=1 is always 0", (await derivePick(V_RAND, V_NONCE, "number", 0, 1)) === 0);
check("derivePick rejects n > 2^32", (await derivePick(V_RAND, V_NONCE, "number", 0, 4294967297)) === null);

/* 24. deriveItem: the per-type draw scheme ------------------------------ */
check("deriveItem number", (await deriveItem({ type: "number" }, SHAPE_COLORS, V_RAND, V_NONCE, "number", 0)) === "12");
check(
  "deriveItem number honors bounds",
  (await deriveItem({ type: "number", min: 5, max: 8 }, SHAPE_COLORS, V_RAND, V_NONCE, "number", 0)) ===
    String(5 + (await derivePick(V_RAND, V_NONCE, "number", 0, 4)))
);
check("deriveItem color", (await deriveItem({ type: "color" }, SHAPE_COLORS, V_RAND, V_NONCE, "color", 0)) === "#5fffca");
check("deriveItem shape", (await deriveItem({ type: "shape" }, SHAPE_COLORS, V_RAND, V_NONCE, "shape", 0)) === "a 7-sided polygon in #5E8CA8, filled");
check("deriveItem list", (await deriveItem({ type: "list", items: animal.items }, SHAPE_COLORS, V_RAND, V_NONCE, "animal", 0)) === "wombat");
check("deriveItem meta item uses base 1", (await deriveItem({ type: "list", items: animal.items }, SHAPE_COLORS, V_RAND, V_NONCE, "animal", 1)) === "gazelle");
check(
  "deriveItem color via meta starts at draw 1",
  (await deriveItem({ type: "color" }, SHAPE_COLORS, V_RAND, V_NONCE, "color", 1)) ===
    "#" + (await Promise.all([1, 2, 3, 4, 5, 6].map((d) => derivePick(V_RAND, V_NONCE, "color", d, 16)))).map((i) => "0123456789abcdef"[i]).join("")
);

/* 25. shipped derivation matches the server's byte-for-byte ------------- */
const eqHome = await (await worker.fetch(req("/", { headers: { accept: "text/html" } }), env, ctx)).text();
check("home leaves no __DERIVE_FN__ placeholder", !eqHome.includes("__DERIVE_FN__"));
check("home leaves no cadence placeholders", !eqHome.includes("__BEACON_CAP_MS__") && !eqHome.includes("__BEACON_INTERVAL_MS__"));
check("client cadence is injected from beaconTiming", eqHome.includes("var BEACON_CAP_MS = 18000;") && eqHome.includes("var BEACON_INTERVAL_MS = 1000;"));
check("round math stays module-side", !eqHome.includes("function beaconRoundForTime(") && !eqHome.includes("function beaconPublishTime("));
check("home inlines derivePick source", eqHome.includes("function derivePick(randomness, nonce, slug, drawIx, n)"));
check("home inlines the probe", eqHome.includes("function probeBeaconRound(baseUrl, fetchImpl)"));
// 2026-07-29 regression: esbuild (wrangler dev AND deploy) rewrites
// nested function declarations with its keepNames __name helper, which
// does not exist in the browser -- toString injection shipped it and
// every press died on "Uncaught ReferenceError: __name is not defined".
// The bundle is a string literal now, and these two checks keep it that
// way: byte-identical to the module sources, free of bundler helpers.
check(
  "injected bundle is byte-identical to module sources",
  deriveFnsSrc() === [derivePick, deriveDie, deriveItem, probeBeaconRound].map((f) => f.toString()).join("\n")
);
check("shipped home carries no bundler helpers", !eqHome.includes("__name(") && !deriveFnsSrc().includes("__name"));
check("client shows the pending state", eqHome.includes("awaiting beacon") && eqHome.includes('" round "'));
check("client renders the verified badge", eqHome.includes("verified &middot; round"));
check("cards carry a proof slot", eqHome.includes('class="proof"'));
check("footer links to /verify", eqHome.includes('href="/verify"'));
const eqScript = eqHome.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)[1];
const clientDerive = new Function(
  sliceFn(eqScript, "derivePick") + "\n" + sliceFn(eqScript, "deriveItem") +
  "\nreturn { derivePick: derivePick, deriveItem: deriveItem };"
)();
check("client derivePick matches server", (await clientDerive.derivePick(V_RAND, V_NONCE, "number", 0, 100)) === 11);
check(
  "client deriveItem matches server (shape)",
  (await clientDerive.deriveItem({ type: "shape" }, SHAPE_COLORS, V_RAND, V_NONCE, "shape", 0)) ===
    (await deriveItem({ type: "shape" }, SHAPE_COLORS, V_RAND, V_NONCE, "shape", 0))
);
check("client deriveItem matches server (color)", (await clientDerive.deriveItem({ type: "color" }, SHAPE_COLORS, V_RAND, V_NONCE, "color", 0)) === "#5fffca");

/* 26. API picks carry recomputable proof (beacon healthy) ---------------- */
beaconMode = "healthy";
seedBeacon(500000);
const jProofNum = await (await post("number")).json();
check(
  "number pick carries proof",
  !!(jProofNum.proof && typeof jProofNum.proof.round === "number" && /^[0-9a-f]{16}$/.test(jProofNum.proof.nonce)),
  JSON.stringify(jProofNum.proof)
);
// Probe-forward commit: the target is the first round the stub would not
// serve at commit time -- horizon+1 = latest+3 in the seeded state.
check("commit is the first unserved round", jProofNum.proof.round === 500003, jProofNum.proof.round);
check(
  "number pick recomputes from its proof",
  (await deriveItem({ type: "number" }, SHAPE_COLORS, await beaconRandomness(jProofNum.proof.round), jProofNum.proof.nonce, "number", 0)) === jProofNum.item
);
const jProofColor = await (await post("color")).json();
check(
  "color pick recomputes from its proof",
  (await deriveItem({ type: "color" }, SHAPE_COLORS, await beaconRandomness(jProofColor.proof.round), jProofColor.proof.nonce, "color", 0)) === jProofColor.item,
  jProofColor.item
);
const jProofAnimal = await (await post("animal")).json();
check(
  "list pick recomputes from its proof",
  (await deriveItem({ type: "list", items: animal.items }, SHAPE_COLORS, await beaconRandomness(jProofAnimal.proof.round), jProofAnimal.proof.nonce, "animal", 0)) === jProofAnimal.item
);
const jProofUser = await (await post("random-dinosaur")).json();
const dinoRec = JSON.parse(kv.get("c:random-dinosaur"));
check(
  "user pick recomputes from its proof",
  (await deriveItem({ type: "list", items: dinoRec.items }, SHAPE_COLORS, await beaconRandomness(jProofUser.proof.round), jProofUser.proof.nonce, "random-dinosaur", 0)) === jProofUser.item
);
// Locks the badge rule the meta->user path depends on: a direct pick (which
// is what the browser's delegation POSTs) is derived at base 0 and its
// response carries NO via -- so the badge must not add one either.
check("direct user pick carries no via field", !("via" in jProofUser), JSON.stringify(Object.keys(jProofUser)));
check("user pick still counts", typeof jProofUser.count === "number", jProofUser.count);

// The meta pick: pool draw 0 chooses the chooser, item draws start at 1.
const jProofMeta = await (await post("random")).json();
check("meta pick carries proof and via", !!(jProofMeta.proof && jProofMeta.via && jProofMeta.via.slug));
const metaUsers = [...kv.keys()]
  .filter((k) => k.startsWith("c:"))
  .map((k) => JSON.parse(kv.get(k)))
  .sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));
const metaManifest = BUILTINS.map((b) => ({ slug: b.slug, name: b.name, kind: b.kind, type: b.type }))
  .concat(metaUsers.map((u) => ({ slug: u.slug, name: u.name, kind: u.kind, type: u.type })));
const metaPool = computePool(metaManifest);
const metaRand = await beaconRandomness(jProofMeta.proof.round);
const poolIdx = await derivePick(metaRand, jProofMeta.proof.nonce, "random", 0, metaPool.length);
check(
  "meta pool draw recomputes the delegation",
  !!(metaPool[poolIdx] && metaPool[poolIdx].slug === jProofMeta.via.slug),
  poolIdx + " -> " + ((metaPool[poolIdx] || {}).slug) + " vs " + jProofMeta.via.slug
);
const metaChosen = BUILTINS.find((b) => b.slug === jProofMeta.via.slug);
const metaDesc = metaChosen
  ? metaChosen.type === "list"
    ? { type: "list", items: metaChosen.items }
    : { type: metaChosen.type }
  : { type: "list", items: JSON.parse(kv.get("c:" + jProofMeta.via.slug)).items };
check(
  "meta item recomputes at base 1",
  (await deriveItem(metaDesc, SHAPE_COLORS, metaRand, jProofMeta.proof.nonce, jProofMeta.via.slug, 1)) === jProofMeta.item,
  jProofMeta.item
);

/* 27. beacon down: fallback picks, badged, API proof null ---------------- */
beaconMode = "down";
const savedTiming = { ...beaconTiming };
beaconTiming.intervalMs = 1;
beaconTiming.capMs = 40;
const jFbNum = await (await post("number")).json();
check("fallback number pick has proof null", jFbNum.proof === null, JSON.stringify(jFbNum.proof));
const fbNum = Number(jFbNum.item);
check("fallback number pick still valid", Number.isInteger(fbNum) && fbNum >= 1 && fbNum <= 100, jFbNum.item);
const jFbUser = await (await post("random-dinosaur")).json();
check("fallback user pick has proof null", jFbUser.proof === null);
check("fallback user pick still from the list", dinoRec.items.includes(jFbUser.item), jFbUser.item);
check("fallback user pick still counts", typeof jFbUser.count === "number");
const jFbMeta = await (await post("random")).json();
check("fallback meta pick has proof null", jFbMeta.proof === null);
check("fallback meta pick still delegates", !!(jFbMeta.via && jFbMeta.via.slug && typeof jFbMeta.item === "string"));
beaconMode = "healthy";
Object.assign(beaconTiming, savedTiming);
check("beacon recovers after fallback", (await (await post("number")).json()).proof !== null);

/* 28. awaitBeaconRound polling ------------------------------------------- */
beaconTiming.intervalMs = 1;
beaconTiming.capMs = 500;
let pollCalls = 0;
const flaky = async () => {
  pollCalls++;
  if (pollCalls < 3) return new Response("not found", { status: 404 });
  return Response.json({ round: 7, randomness: "ab".repeat(32) });
};
check("poller waits out 404s", (await awaitBeaconRound(7, flaky)) === "ab".repeat(32));
check("poller retried until publication", pollCalls === 3, pollCalls);
const throwing = async () => { throw new Error("network dead"); };
check("poller caps out to null on a dead beacon", (await awaitBeaconRound(7, throwing)) === null);
// A held round through the global stub follows the path handlePick uses.
// The wrapper must be installed before awaitBeaconRound is called: it
// binds the default fetch at invocation time.
beaconHold.add(424242);
let releaseCalls = 0;
const stubFetch = globalThis.fetch;
globalThis.fetch = async (u) => {
  releaseCalls++;
  if (releaseCalls >= 4) beaconHold.delete(424242);
  return stubFetch(u);
};
check("poller returns once the round publishes", (await awaitBeaconRound(424242)) === (await beaconRandomness(424242)));
globalThis.fetch = stubFetch;
Object.assign(beaconTiming, savedTiming);

/* 28b. probe-forward commit --------------------------------------------- */
beaconMode = "healthy";
// Happy path: latest L, horizon L+2 -> walk two 200s, commit L+3.
seedBeacon(700000);
check("probe commits to the first unserved round", (await probeBeaconRound(BEACON_PREFIX, fetch)) === 700003);
// A second probe of the same state has advanced: the first probe's 404
// plus this probe's re-fetch "published" 700003, so the walk continues.
check(
  "probe advances past rounds published in between",
  (await probeBeaconRound(BEACON_PREFIX, fetch)) > 700003
);
// Badly stale /public/latest: every walk probe 200s, the walk is bounded
// at 10, and the commit is the last probed round + 1.
seedBeacon(700100);
beaconHorizon = 700199; // 99 rounds ahead of latest
beaconAttempts.clear();
check("stale latest: bounded walk commits last-probed + 1", (await probeBeaconRound(BEACON_PREFIX, fetch)) === 700111);
// The probe itself erroring goes straight to the fallback.
beaconMode = "down";
check("probe network error yields null", (await probeBeaconRound(BEACON_PREFIX, fetch)) === null);
const jProbeDown = await (await post("number")).json();
check("probe failure falls back with proof null", jProbeDown.proof === null);
check("probe failure still returns a valid pick", Number(jProbeDown.item) >= 1 && Number(jProbeDown.item) <= 100, jProbeDown.item);
beaconMode = "healthy";
// A seed fetch that never settles (blackholed connection — content
// blocker, VPN, filtered DNS dropping the request) must time out into
// the fallback, not pin the press on "awaiting beacon" forever.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const t0 = Date.now();
  const hung = await probeBeaconRound(BEACON_PREFIX, fetch);
  const hungMs = Date.now() - t0;
  globalThis.fetch = realFetch;
  check("blackholed beacon seed times out to null", hung === null);
  check("blackholed seed respects the ~6s backstop", hungMs >= 5900 && hungMs < 9000, hungMs + "ms");
}
// Committed round that never publishes: poll cap -> fallback.
seedBeacon(700200);
beaconHold.add(700203); // the round the probe will commit to
beaconTiming.intervalMs = 1;
beaconTiming.capMs = 40;
const jTimeout = await (await post("number")).json();
check("unpublished-at-cap falls back with proof null", jTimeout.proof === null);
check("unpublished-at-cap still returns a valid pick", Number(jTimeout.item) >= 1 && Number(jTimeout.item) <= 100, jTimeout.item);
beaconTiming.intervalMs = 1000;
beaconTiming.capMs = 18000;
seedBeacon(700300);

/* 29. /verify page and /api/items ---------------------------------------- */
const rVerify = await worker.fetch(req("/verify", { headers: { accept: "text/html" } }), env, ctx);
const verifyHtml = await rVerify.text();
check("/verify returns 200 HTML", rVerify.status === 200 && verifyHtml.startsWith("<!doctype html>"));
check("/verify has the form", verifyHtml.includes('id="verify-form"') && verifyHtml.includes('id="v-slug"') && verifyHtml.includes('id="v-item"'));
check("/verify leaves no placeholders", !verifyHtml.includes("__DERIVE_FN__") && !verifyHtml.includes("__VERIFY_TYPES__") && !verifyHtml.includes("__SHAPE_COLORS__"));
check(
  "/verify inlines the derivation",
  verifyHtml.includes("function derivePick(randomness, nonce, slug, drawIx, n)") &&
    verifyHtml.includes("function deriveItem(c, palette, randomness, nonce, slug, base)")
);
check("/verify inlines the type map", verifyHtml.includes('"simpsons-character":"list"') && verifyHtml.includes('"random":"meta"'));
check("/verify points at the beacon", verifyHtml.includes("https://drand.cloudflare.com/"));
check("/verify honors the no-template-literal invariant", !verifyHtml.includes("`${"));
const verifyScript = verifyHtml.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
let verifyParses = "no script";
if (verifyScript) {
  try {
    new Function(verifyScript[1]);
    verifyParses = true;
  } catch (e) {
    verifyParses = e.message;
  }
}
check("verify script parses", verifyParses === true, verifyParses);

const rItems = await worker.fetch(req("/api/items/animal"), env, ctx);
const jItems = await rItems.json();
check("/api/items serves a built-in list", rItems.status === 200 && jItems.items.length === animal.items.length);
const rItemsUser = await worker.fetch(req("/api/items/random-dinosaur"), env, ctx);
check("/api/items serves a user list", (await rItemsUser.json()).items.length === dinoRec.items.length);
check("/api/items 404s unknown slugs", (await worker.fetch(req("/api/items/nope"), env, ctx)).status === 404);
check("/api/items 404s choosers without lists", (await worker.fetch(req("/api/items/number"), env, ctx)).status === 404);

/* 30. browser fallback paths, executed from the shipped script ------------ */
// clientRuntime evals functions extracted from a shipped <script> with stub
// globals, so the tests run the exact source the browser runs.
function clientRuntime(scriptSrc, names, globals) {
  const src = names
    .map((n) => {
      const s = sliceFn(scriptSrc, n);
      if (!s) throw new Error("client fn not found in shipped script: " + n);
      return s;
    })
    .join("\n");
  const keys = Object.keys(globals);
  const factory = new Function(...keys, src + "\nreturn { " + names.map((n) => n + ": " + n).join(", ") + " };");
  return factory(...keys.map((k) => globals[k]));
}

function stubPressCard(type, withBounds) {
  const proof = { innerHTML: "" };
  const firstChild = { textContent: "" };
  const result = { className: "", innerHTML: "", firstChild };
  const err = { hidden: true, textContent: "" };
  const minIn = { value: "-1000000000000" };
  const maxIn = { value: "1000000000000" };
  return {
    proof, result, err, firstChild,
    getAttribute: (a) => (a === "data-type" ? type : null),
    querySelector: (sel) =>
      sel === ".proof" ? proof :
      sel === ".result" ? result :
      sel === ".card-err" ? err :
      sel === ".num-min" ? (withBounds ? minIn : null) :
      sel === ".num-max" ? (withBounds ? maxIn : null) : null,
  };
}

const boom = (name) => () => { throw new Error(name + " must not be called on this path"); };
const CLIENT_FNS = [
  "rand", "randInt", "pick", "scramble", "resultEl", "errEl", "showErr",
  "proofEl", "clearProof", "showProof", "pendingBeacon", "textResult", "numberBounds",
  "pressNumber", "pressList", "localBuiltin", "pressVerified",
];
const rtA = clientRuntime(eqScript, CLIENT_FNS, {
  LISTS: {}, SHAPE_COLORS, HEX: "0123456789abcdef", reduce: true,
  probeBeaconRound: boom("probeBeaconRound"), fetchBeacon: boom("fetchBeacon"),
  deriveItem: boom("deriveItem"), mintNonce: function () { return "0123456789abcdef"; },
  BEACON_URL: "about:blank", fetch: boom("fetch"),
});

// Fallback badge: a null proof is always a visible "unverified".
const fbCard = stubPressCard("number", false);
rtA.showProof(fbCard, null);
check("fallback badges unverified", fbCard.proof.innerHTML.includes("unverified"), fbCard.proof.innerHTML);

// Span wider than 2^32: early-out with a local pick and an unverified
// badge, before the button is ever disabled or the beacon touched (the
// boom globals above fire if the flow reaches the probe).
const wideCard = stubPressCard("number", true);
const wideBtn = { disabled: false };
rtA.pressVerified(wideCard, "number", wideBtn);
check("span > 2^32 renders a local pick", wideCard.firstChild.textContent !== "", wideCard.firstChild.textContent);
check("span > 2^32 badges unverified", wideCard.proof.innerHTML.includes("unverified"));
check("span > 2^32 never disabled the button", wideBtn.disabled === false);

// 2026-07-29 regression: the probe used to be called at the raw head of
// the promise chain, so a SYNCHRONOUS throw there (boom below stands in
// for the esbuild __name ReferenceError) escaped every catch and pinned
// the card on "awaiting beacon" forever. The wrapped head must convert
// it into the fallback: local pick, unverified badge, button recovered.
const throwCard = stubPressCard("number", false);
const throwBtn = { disabled: false };
rtA.pressVerified(throwCard, "number", throwBtn);
await new Promise(function (r) { setTimeout(r, 0); });
check("sync-throwing probe falls back to a local pick", throwCard.firstChild.textContent !== "", throwCard.firstChild.textContent);
check("sync-throwing probe badges unverified", throwCard.proof.innerHTML.includes("unverified"), throwCard.proof.innerHTML);
check("sync-throwing probe re-enables the button", throwBtn.disabled === false);

// Meta finish-with-null (beacon down mid-press): local pick + unverified.
const metaCard = stubPressCard("meta", false);
const viaEl = { textContent: "" };
const rtF = clientRuntime(eqScript, ["finish", "localBuiltin", "pressNumber", "numberBounds", "textResult", "scramble", "resultEl", "errEl", "showErr", "proofEl", "clearProof", "showProof", "rand", "randInt", "pick"], {
  viaEl, card: metaCard, LISTS: {}, SHAPE_COLORS, HEX: "0123456789abcdef", reduce: true,
  deriveItem: async () => null, pressKv: async () => true,
});
rtF.finish({ kind: "builtin", type: "number", slug: "number", name: "number" }, null);
check("meta fallback sets the via line", viaEl.textContent === "via number", viaEl.textContent);
check("meta fallback badges unverified", metaCard.proof.innerHTML.includes("unverified"));
// ...and the derived-but-null path (empty list defense) does the same.
const metaCard2 = stubPressCard("meta", false);
const rtF2 = clientRuntime(eqScript, ["finish", "localBuiltin", "pressNumber", "numberBounds", "textResult", "scramble", "resultEl", "errEl", "showErr", "proofEl", "clearProof", "showProof", "rand", "randInt", "pick"], {
  viaEl: { textContent: "" }, card: metaCard2, LISTS: {}, SHAPE_COLORS, HEX: "0123456789abcdef", reduce: true,
  deriveItem: async () => null, pressKv: async () => true,
});
await rtF2.finish(
  { kind: "builtin", type: "number", slug: "number", name: "number" },
  { round: 1, nonce: "ab", randomness: "cd" }
);
check("meta null-item defense badges unverified", metaCard2.proof.innerHTML.includes("unverified"));

/* 31. badge URL rules ------------------------------------------------------ */
function badgeHref(card, proof) {
  rtA.showProof(card, proof);
  const m = card.proof.innerHTML.match(/href="([^"]+)"/);
  return m ? m[1] : null;
}
const urlDefault = badgeHref(stubPressCard("number", false), { slug: "number", round: 777, nonce: "ab", item: "42" });
check("badge without bounds omits min/max", !!urlDefault && !urlDefault.includes("min="), urlDefault);
const urlDefaultExplicit = badgeHref(stubPressCard("number", false), { slug: "number", round: 777, nonce: "ab", item: "42", min: 1, max: 100 });
check("badge with 1/100 omits min/max", !!urlDefaultExplicit && !urlDefaultExplicit.includes("min="), urlDefaultExplicit);
const urlCustom = badgeHref(stubPressCard("number", false), { slug: "number", round: 777, nonce: "ab", item: "6", min: 5, max: 8 });
check("badge with custom bounds carries min/max", !!urlCustom && urlCustom.includes("&min=5&max=8"), urlCustom);
const urlVia = badgeHref(stubPressCard("number", false), { slug: "animal", round: 777, nonce: "ab", item: "wombat", via: "random" });
check("meta badge carries via", !!urlVia && urlVia.includes("&via=random"), urlVia);
const urlNoVia = badgeHref(stubPressCard("number", false), { slug: "random-dinosaur", round: 777, nonce: "ab", item: "Raptor" });
check("direct-pick badge has no via (recomputes at base 0)", !!urlNoVia && !urlNoVia.includes("via="), urlNoVia);
// A hostile round value must never reach innerHTML raw.
const evilCard = stubPressCard("number", false);
rtA.showProof(evilCard, { slug: "number", round: '<img src=x onerror=alert(1)>', nonce: "ab", item: "42" });
check("hostile round coerced to unverified badge", evilCard.proof.innerHTML.includes("unverified") && !evilCard.proof.innerHTML.includes("<img"), evilCard.proof.innerHTML);
const strRound = badgeHref(stubPressCard("number", false), { slug: "number", round: "777", nonce: "ab", item: "42" });
check("string round coerces cleanly", !!strRound && strRound.includes("round=777"), strRound);

/* 32. /verify script logic, executed from the shipped page ----------------- */
const TYPES_MAP = Object.fromEntries(BUILTINS.map((b) => [b.slug, b.type]));
function verifyDom(fields) {
  const verdict = { className: "verdict", textContent: "" };
  const link = { innerHTML: "" };
  const els = {};
  for (const k of ["slug", "round", "nonce", "item", "via", "min", "max"]) {
    els["v-" + k] = { value: fields[k] !== undefined ? fields[k] : "" };
  }
  return {
    verdict, link,
    doc: {
      getElementById: (id) => (id === "verdict" ? verdict : id === "drand-link" ? link : els[id] || null),
    },
  };
}
function mkVerifyFetch(log, { randomness, items = {}, beacon404s = 0 }) {
  let beaconCalls = 0;
  const f = async (url) => {
    const u = String(url);
    log.push(u);
    if (u.startsWith(BEACON_PREFIX)) {
      beaconCalls++;
      if (beaconCalls <= beacon404s) return new Response("not found", { status: 404 });
      return Response.json({ round: 777, randomness });
    }
    if (u.startsWith("/api/items/")) {
      const slug = decodeURIComponent(u.split("/").pop());
      const list = items[slug];
      return Response.json(list ? { slug, items: list } : { error: "no item list for that slug" }, { status: list ? 200 : 404 });
    }
    throw new Error("unexpected verify fetch: " + u);
  };
  f.beaconCalls = () => beaconCalls;
  return f;
}
function verifyRuntime(dom, fetchImpl) {
  return clientRuntime(verifyScript[1], ["el", "say", "sleepVerify", "fetchRound", "run"], {
    document: dom.doc, TYPES: TYPES_MAP, PALETTE: SHAPE_COLORS,
    deriveItem, fetch: fetchImpl, BEACON_URL: BEACON_PREFIX,
  });
}
async function runVerify(fields, fetchImpl) {
  const dom = verifyDom(fields);
  const rt = verifyRuntime(dom, fetchImpl);
  rt.run();
  const t0 = Date.now();
  while (!/\b(ok|err)\b/.test(dom.verdict.className)) {
    if (Date.now() - t0 > 8000) throw new Error("verify run timed out; verdict: " + dom.verdict.textContent);
    await new Promise((r) => setTimeout(r, 10));
  }
  return dom;
}

// via present -> item draws at base 1: an item computed at base 1 verifies,
// and the same inputs without via do not.
const viaItem = await deriveItem({ type: "list", items: animal.items }, SHAPE_COLORS, V_RAND, V_NONCE, "animal", 1);
const viaLog = [];
const viaDom = await runVerify(
  { slug: "animal", round: "777", nonce: V_NONCE, item: viaItem, via: "random" },
  mkVerifyFetch(viaLog, { randomness: V_RAND, items: { animal: animal.items } })
);
check("verify: via pick matches at base 1", viaDom.verdict.className.includes("ok") && viaDom.verdict.textContent.includes("matches"), viaDom.verdict.textContent);
check("verify: beacon fetch is cache-busted", viaLog.some((u) => u.includes("?v=777-")), viaLog[0]);
const noViaDom = await runVerify(
  { slug: "animal", round: "777", nonce: V_NONCE, item: viaItem, via: "" },
  mkVerifyFetch([], { randomness: V_RAND, items: { animal: animal.items } })
);
check("verify: same pick without via mismatches", noViaDom.verdict.className.includes("err") && noViaDom.verdict.textContent.includes("does not verify"), noViaDom.verdict.textContent);

// Inverted bounds are refused before any fetch (an empty span would make
// the derivation a constant and any round/nonce "verify").
const invLog = [];
const invDom = await runVerify(
  { slug: "number", round: "777", nonce: V_NONCE, item: "50", min: "100", max: "1" },
  mkVerifyFetch(invLog, { randomness: V_RAND })
);
check("verify: inverted bounds rejected", invDom.verdict.className.includes("err") && invDom.verdict.textContent.includes("min must not be greater than max"), invDom.verdict.textContent);
check("verify: inverted bounds rejected before fetching", invLog.length === 0, invLog.join(","));

// Unknown slug falls back to the list scheme and fetches its items.
const dinoItems = ["Raptor", "T-Rex", "Stegosaurus", "Triceratops", "Ankylosaurus", "Brontosaurus", "Pterodactyl", "Mosasaurus"];
const dinoItem = await deriveItem({ type: "list", items: dinoItems }, SHAPE_COLORS, V_RAND, V_NONCE, "dino", 0);
const dinoLog = [];
const dinoDom = await runVerify(
  { slug: "dino", round: "777", nonce: V_NONCE, item: dinoItem },
  mkVerifyFetch(dinoLog, { randomness: V_RAND, items: { dino: dinoItems } })
);
check("verify: unknown slug uses the list scheme", dinoDom.verdict.className.includes("ok"), dinoDom.verdict.textContent);
check("verify: items fetched for the list scheme", dinoLog.some((u) => u === "/api/items/dino"), dinoLog.join(","));

// A 404 (the press's probe may have cached one) is retried before failing.
const retryLog = [];
const retryFetch = mkVerifyFetch(retryLog, { randomness: V_RAND, items: { animal: animal.items }, beacon404s: 1 });
const retryDom = await runVerify(
  { slug: "animal", round: "777", nonce: V_NONCE, item: viaItem, via: "random" },
  retryFetch
);
check("verify: 404 retried then verifies", retryDom.verdict.className.includes("ok"), retryDom.verdict.textContent);
check("verify: retry hit the beacon twice", retryFetch.beaconCalls() === 2, retryFetch.beaconCalls());

// /verify defaults reconstruct the press derivation for default bounds;
// custom bounds recompute from the carried min/max.
const defItem = await deriveItem({ type: "number" }, SHAPE_COLORS, V_RAND, V_NONCE, "number", 0);
const defDom = await runVerify(
  { slug: "number", round: "777", nonce: V_NONCE, item: defItem },
  mkVerifyFetch([], { randomness: V_RAND })
);
check("verify: default bounds reconstruct 1-100 derivation", defDom.verdict.className.includes("ok"), defDom.verdict.textContent);
const custItem = await deriveItem({ type: "number", min: 5, max: 8 }, SHAPE_COLORS, V_RAND, V_NONCE, "number", 0);
const custDom = await runVerify(
  { slug: "number", round: "777", nonce: V_NONCE, item: custItem, min: "5", max: "8" },
  mkVerifyFetch([], { randomness: V_RAND })
);
check("verify: custom bounds recompute from min/max", custDom.verdict.className.includes("ok"), custDom.verdict.textContent);

// The mismatch hint is scoped: built-in lists (ship with the site) and
// visitor-made lists (fixed forever, old-era caveat) fail differently.
const builtinHintDom = await runVerify(
  { slug: "animal", round: "777", nonce: V_NONCE, item: "not-on-the-list" },
  mkVerifyFetch([], { randomness: V_RAND, items: { animal: animal.items } })
);
check(
  "verify: built-in mismatch blames site updates",
  builtinHintDom.verdict.className.includes("err") && builtinHintDom.verdict.textContent.includes("ship with the site"),
  builtinHintDom.verdict.textContent
);
const userHintDom = await runVerify(
  { slug: "dino", round: "777", nonce: V_NONCE, item: "not-on-the-list" },
  mkVerifyFetch([], { randomness: V_RAND, items: { dino: dinoItems } })
);
check(
  "verify: user mismatch cites static lists and the old era",
  userHintDom.verdict.className.includes("err") &&
    userHintDom.verdict.textContent.includes("never change") &&
    userHintDom.verdict.textContent.includes("July 2026"),
  userHintDom.verdict.textContent
);

/* 33. end-to-end: a pick on a vestigial-listDay record verifies -------- */
// The change's core promise, composed: a legacy record still carrying a
// listDay field is pressed over the API (no regeneration, real proof),
// then the shipped /verify script recomputes that exact pick.
const legacyItems = ["sparrow", "starling", "swift", "swallow", "magpie", "rook", "wren", "finch", "heron", "kestrel"];
kv.set("c:legacy-birds", JSON.stringify({
  slug: "legacy-birds", name: "legacy birds", kind: "user",
  items: legacyItems, created: "2026-01-01T00:00:00.000Z", listDay: "2026-01-01",
}));
seedBeacon(800000);
const genCallsPreLegacy = genCalls;
const pendingPreLegacy = pending.length;
const rLegacy = await worker.fetch(req("/api/pick/legacy-birds", { method: "POST" }), env, ctx);
const jLegacy = await rLegacy.json();
check(
  "legacy-record pick returns 200 with proof",
  rLegacy.status === 200 && !!(jLegacy.proof && typeof jLegacy.proof.round === "number"),
  JSON.stringify(jLegacy.proof)
);
check("legacy-record pick comes from the stored list", legacyItems.includes(jLegacy.item), jLegacy.item);
check(
  "legacy-record pick triggers no AI call and no background work",
  genCalls === genCallsPreLegacy && pending.length === pendingPreLegacy
);
const legacyDom = await runVerify(
  { slug: "legacy-birds", round: String(jLegacy.proof.round), nonce: jLegacy.proof.nonce, item: jLegacy.item },
  mkVerifyFetch([], { randomness: await beaconRandomness(jLegacy.proof.round), items: { "legacy-birds": legacyItems } })
);
check(
  "legacy-record pick verifies end-to-end",
  legacyDom.verdict.className.includes("ok") && legacyDom.verdict.textContent.includes("matches — verified"),
  legacyDom.verdict.textContent
);
check(
  "legacy record kept its vestigial listDay",
  JSON.parse(kv.get("c:legacy-birds")).listDay === "2026-01-01"
);

/* 34. pre-filled number bounds on the permalink ------------------------- */
// GET /c/number?min=X&max=Y renders the chooser's bounds inputs pre-filled
// server-side. The acceptance set mirrors the client clamped(): parseFloat
// -> isFinite -> Math.round -> clamp +/-1e12. One check per I/O matrix row.
async function cBody(path, init) {
  const r = await worker.fetch(req(path, init || { headers: { accept: "text/html" } }), env, ctx);
  return { status: r.status, body: await r.text() };
}
function numValues(body) {
  const min = body.match(/class="num-min" value="([^"]*)"/);
  const max = body.match(/class="num-max" value="([^"]*)"/);
  return { min: min && min[1], max: max && max[1] };
}
const boundRows = [
  ["HAPPY_PATH", "?min=5&max=8", "5", "8"],
  ["NO_PARAMS", "", "1", "100"],
  ["PARTIAL", "?max=7", "1", "7"],
  ["NON_NUMERIC", "?min=abc&max=", "1", "100"],
  ["FRACTIONAL", "?min=5.7&max=8.2", "6", "8"],
  ["EXPONENT", "?min=1e3", "1000", "100"],
  ["TRAILING_JUNK", "?min=5abc", "5", "100"],
  ["NON_FINITE", "?min=Infinity&max=NaN", "1", "100"],
  ["OUT_OF_CAP", "?min=-5e12&max=5e12", "-1000000000000", "1000000000000"],
  ["MIN_OVER_CAP", "?min=5e12", "1000000000000", "100"],
  ["MAX_UNDER_CAP", "?max=-5e12", "1", "-1000000000000"],
  ["CAP_EXACT", "?min=1e12&max=-1e12", "1000000000000", "-1000000000000"],
  ["CAP_ROUND_EDGE", "?min=1000000000000.6", "1000000000000", "100"],
  ["NEGATIVE", "?min=-9&max=-2", "-9", "-2"],
  ["DEGENERATE", "?min=4&max=4", "4", "4"],
  ["SWAPPED", "?min=9&max=3", "9", "3"],
  ["DUPLICATE_PARAM", "?min=5&min=7", "5", "100"],
];
for (const [rowName, query, expMin, expMax] of boundRows) {
  const { status, body } = await cBody("/c/number" + query);
  const v = numValues(body);
  check(
    "bounds " + rowName + " renders " + expMin + " / " + expMax,
    status === 200 && v.min === expMin && v.max === expMax,
    "status " + status + ", got " + v.min + " / " + v.max
  );
}

// MARKUP_INJECTION, two checks: percent-encoded and raw. The URL layer
// normalizes the raw form to the encoded one before searchParams sees it,
// so both must converge on the defaults. Asserted as full-body equality
// against the no-params baseline under a fixed cookie fixture -- strictly
// stronger than scanning for any particular payload string, and matching
// the spec's "no injected markup anywhere in the body".
const boundsCookie = await freshCookie();
const fixedInit = { headers: { accept: "text/html", cookie: "rc_uid=" + boundsCookie } };
const injBaseline = await cBody("/c/number", fixedInit);
for (const [form, query] of [["percent-encoded", "?min=%3Cscript%3E"], ["raw", "?min=<script>"]]) {
  const { status, body } = await cBody("/c/number" + query, fixedInit);
  check(
    "bounds MARKUP_INJECTION (" + form + ") renders defaults, no injected markup",
    status === 200 && body === injBaseline.body,
    "status " + status + ", body length " + body.length + " vs baseline " + injBaseline.body.length
  );
}

// OTHER_TYPE and USER_CHOOSER: params ignored, body identical to the same
// request without params, under the same fixed cookie fixture.
const colorPlain = await cBody("/c/color", fixedInit);
const colorParams = await cBody("/c/color?min=5&max=8", fixedInit);
check(
  "bounds OTHER_TYPE (/c/color) ignores min/max",
  colorParams.status === 200 && colorParams.body === colorPlain.body,
  "body lengths " + colorParams.body.length + " vs " + colorPlain.body.length
);
const userPlain = await cBody("/c/random-dinosaur", fixedInit);
const userParams = await cBody("/c/random-dinosaur?min=5&max=8", fixedInit);
check(
  "bounds USER_CHOOSER ignores min/max",
  userParams.status === 200 && userParams.body === userPlain.body,
  "body lengths " + userParams.body.length + " vs " + userPlain.body.length
);

/* 35. server/client bounds agreement ------------------------------------ */
// The load-bearing invariant, locked by execution rather than prose: any
// value the server renders into a bounds input passes through the shipped
// client numberBounds unchanged whenever min <= max (clamped() must not
// rewrite it). The other input is pinned to the far cap so the documented
// swap path never fires here; the swap itself is locked separately below.
const CAP_STR = "1000000000000";
for (const query of boundRows.map((r) => r[1]).concat(["?min=%3Cscript%3E", "?min=<script>"])) {
  const { status, body } = await cBody("/c/number" + query);
  const v = numValues(body);
  const minIn = { value: v.min };
  const minCard = { querySelector: (sel) => (sel === ".num-min" ? minIn : sel === ".num-max" ? { value: CAP_STR } : null) };
  const nbMin = rtA.numberBounds(minCard);
  const maxIn = { value: v.max };
  const maxCard = { querySelector: (sel) => (sel === ".num-max" ? maxIn : sel === ".num-min" ? { value: "-" + CAP_STR } : null) };
  const nbMax = rtA.numberBounds(maxCard);
  check(
    "agreement [" + (query || "no params") + "]: client keeps " + v.min + " / " + v.max,
    status === 200 && nbMin.a === Number(v.min) && minIn.value === Number(v.min) && nbMax.b === Number(v.max) && maxIn.value === Number(v.max),
    "status " + status + ", client returned " + nbMin.a + " / " + nbMax.b + " for rendered " + v.min + " / " + v.max
  );
}

// The per-input agreement above can never exercise the swap; lock the
// documented SWAPPED behavior end to end: the rendered 9 / 3 pair goes
// through numberBounds together and comes back 3 / 9 with both inputs
// rewritten -- exactly what the spec says a press must do.
{
  const { body } = await cBody("/c/number?min=9&max=3");
  const v = numValues(body);
  const swapMin = { value: v.min };
  const swapMax = { value: v.max };
  const swapCard = { querySelector: (sel) => (sel === ".num-min" ? swapMin : sel === ".num-max" ? swapMax : null) };
  const nb = rtA.numberBounds(swapCard);
  check(
    "agreement SWAPPED pair: press swaps 9 / 3 to 3 / 9 and rewrites both inputs",
    nb.a === 3 && nb.b === 9 && swapMin.value === 3 && swapMax.value === 9,
    "client returned " + nb.a + " / " + nb.b + ", inputs now " + swapMin.value + " / " + swapMax.value
  );
}

/* 36. /dice server-side tray I/O ----------------------------------------- */
// Only inspect markup before the inline CLIENT_SCRIPT. The script contains
// the die-tile HTML template as source text, which must not be counted as a
// rendered die.
function diceMarkup(body) {
  const scriptAt = body.indexOf("<script>");
  return scriptAt === -1 ? body : body.slice(0, scriptAt);
}
function diceValues(body) {
  const values = [];
  const re = /<div class="die" data-min="([^"]+)" data-max="([^"]+)">/g;
  const markup = diceMarkup(body);
  let m;
  while ((m = re.exec(markup))) values.push([Number(m[1]), Number(m[2])]);
  return values;
}
function diceTileMarkups(body) {
  return diceMarkup(body).match(
    /<div class="die" data-min="[^"]+" data-max="[^"]+">[\s\S]*?<\/button><\/div>/g
  ) || [];
}
function diceRollAllDisabled(body) {
  const tag = diceMarkup(body).match(/<button class="strike dice-roll-all dice-roll-control"[^>]*>/);
  return !!(tag && /\sdisabled(?:\s|>)/.test(tag[0]));
}
function diceCapShown(body) {
  const m = diceMarkup(body).match(/<div class="dice-cap"[^>]*>([\s\S]*?)<\/div>/);
  return !!(m && m[1].trim());
}
function repeatedDiceQuery(n, value = "6") {
  return "?" + Array.from({ length: n }, () => "d=" + encodeURIComponent(value)).join("&");
}

const diceRows = [
  ["HAPPY_SHORTHAND", "?d=6&d=20", [[1, 6], [1, 20]], false],
  ["RANGE", "?d=3-17", [[3, 17]], false],
  ["NEG_RANGE", "?d=-5--2", [[-5, -2]], false],
  ["NO_PARAMS", "", [[1, 6]], false],
  ["INVALID", "?d=abc", [], false],
  ["ALL_INVALID", "?d=abc&d=", [], false],
  ["FRACTIONAL_EXPONENT", "?d=5.7&d=1e3", [[1, 6], [1, 1000]], false],
  ["TRAILING_JUNK", "?d=6abc", [[1, 6]], false],
  ["OUT_OF_CAP", "?d=-5e12-5e12", [[-1000000000000, 1000000000000]], false],
  ["SWAPPED", "?d=9-3", [[9, 3]], false],
  ["DEGENERATE", "?d=4-4", [[4, 4]], false],
  ["NEG_SHORTHAND", "?d=-3", [[1, -3]], false],
  ["ZERO", "?d=0", [[1, 0]], false],
  ["CAP_24", repeatedDiceQuery(30), Array.from({ length: 24 }, () => [1, 6]), true],
  ["DUPLICATE_OK", "?d=6&d=6", [[1, 6], [1, 6]], false],
];
for (const [rowName, query, expected, capShown] of diceRows) {
  const { status, body } = await cBody("/dice/" + query);
  const got = diceValues(body);
  check(
    "dice " + rowName + " renders the ordered tray",
    status === 200 &&
      JSON.stringify(got) === JSON.stringify(expected) &&
      diceRollAllDisabled(body) === (expected.length === 0) &&
      diceCapShown(body) === capShown,
    "status " + status + ", got " + JSON.stringify(got) +
      ", disabled " + diceRollAllDisabled(body) + ", cap " + diceCapShown(body)
  );
}

// The cap boundary is deliberately asserted on both sides in addition to
// the 30-param matrix row: 24 is accepted quietly; the 25th is dropped and
// produces the polite cap message.
for (const [n, shown] of [[24, false], [25, true]]) {
  const { status, body } = await cBody("/dice/" + repeatedDiceQuery(n));
  check(
    "dice cap boundary at " + n,
    status === 200 && diceValues(body).length === 24 && diceCapShown(body) === shown,
    "status " + status + ", dice " + diceValues(body).length + ", cap " + diceCapShown(body)
  );
}

// Invalid dice are dropped, unlike a request with no d params. Compare both
// hostile encodings to that empty-tray baseline under one fixed cookie, so
// any reflected markup or request-dependent script data breaks equality.
const diceInjectionBaseline = await cBody("/dice/?d=abc", fixedInit);
for (const [form, query] of [["percent-encoded", "?d=%3Cscript%3E"], ["raw", "?d=<script>"]]) {
  const { status, body } = await cBody("/dice/" + query, fixedInit);
  check(
    "dice MARKUP_INJECTION (" + form + ") renders an inert empty tray",
    status === 200 && body === diceInjectionBaseline.body && diceValues(body).length === 0,
    "status " + status + ", body length " + body.length +
      " vs baseline " + diceInjectionBaseline.body.length
  );
}

const dicePage = await cBody("/dice/?d=2&d=6&d=3-17");
check("homepage links to /dice/", eqHome.includes('href="/dice/"'));
check("dice page links back to the shelf", diceMarkup(dicePage.body).includes('class="dice-back" href="/"'));
check(
  "unrolled dice render coin, d6, and range labels without proof badges",
  diceMarkup(dicePage.body).includes('class="die-face unrolled">coin</div>') &&
    diceMarkup(dicePage.body).includes('class="die-face unrolled">d6</div>') &&
    diceMarkup(dicePage.body).includes('class="die-face unrolled">3–17</div>') &&
    (diceMarkup(dicePage.body).match(/<div class="proof"><\/div>/g) || []).length === 3
);
check(
  "dice tiles keep a persistent visible identity caption",
  diceMarkup(dicePage.body).includes('class="die-label" aria-hidden="true">coin</div>') &&
    diceMarkup(dicePage.body).includes('class="die-label" aria-hidden="true">d6</div>') &&
    diceMarkup(dicePage.body).includes('class="die-label" aria-hidden="true">3–17</div>')
);
check(
  "dice result announcements use one tray-level live region, not one per face and proof",
  diceMarkup(dicePage.body).includes('class="dice-tray" aria-live="polite" aria-atomic="false">') &&
    !/<div class="die-face[^"]*"[^>]*aria-live=/.test(diceMarkup(dicePage.body)) &&
    !/<div class="proof"[^>]*aria-live=/.test(diceMarkup(dicePage.body))
);

/* 37. server/client dice agreement --------------------------------------- */
// Run the parser shipped in CLIENT_SCRIPT, not a test rewrite. Every bound
// rendered by the server must survive the client acceptance core unchanged;
// ordering is a separate roll-only operation.
const diceParseRt = clientRuntime(
  eqScript,
  ["diceBound", "dieFromElement", "diceOrdered", "diceLabel", "diceParam", "diceTileMarkup"],
  {
    esc: (s) => String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    ),
  }
);
function diceAttrTile(min, max) {
  return {
    getAttribute: (name) => name === "data-min" ? String(min) : name === "data-max" ? String(max) : null,
  };
}
for (const [rowName, query] of diceRows) {
  const { status, body } = await cBody("/dice/" + query);
  const serverDice = diceValues(body);
  const parsed = serverDice.map(([min, max]) => diceParseRt.dieFromElement(diceAttrTile(min, max)));
  check(
    "dice agreement " + rowName + " keeps rendered bounds",
    status === 200 &&
      JSON.stringify(parsed) === JSON.stringify(serverDice.map(([min, max]) => ({ min, max }))),
    JSON.stringify(parsed)
  );
}
check(
  "dice client acceptance matches rounding, prefix parsing, and cap",
  diceParseRt.diceBound("5.7") === 6 &&
    diceParseRt.diceBound("6abc") === 6 &&
    diceParseRt.diceBound("Infinity") === null &&
    diceParseRt.diceBound("-5e12") === -1000000000000
);
const clientSwapped = diceParseRt.diceOrdered(diceParseRt.dieFromElement(diceAttrTile(9, 3)));
check(
  "dice roll ordering swaps 9 / 3 without rewriting the rendered die",
  clientSwapped.min === 3 && clientSwapped.max === 9 &&
    diceAttrTile(9, 3).getAttribute("data-min") === "9"
);
check(
  "dice URL serialization is canonical but unswapped",
  diceParseRt.diceParam({ min: 1, max: 6 }) === "6" &&
    diceParseRt.diceParam({ min: 9, max: 3 }) === "9-3"
);
const tileAgreement = await cBody("/dice/?d=2&d=6&d=3-17&d=0&d=-3&d=1");
const tileAgreementBounds = [[1, 2], [1, 6], [3, 17], [1, 0], [1, -3], [1, 1]];
check(
  "dice server and shipped client emit byte-identical tile templates",
  JSON.stringify(diceTileMarkups(tileAgreement.body)) === JSON.stringify(
    tileAgreementBounds.map(([min, max]) => diceParseRt.diceTileMarkup({ min, max }))
  )
);
check(
  "dice shorthand labels use range form when max is not above min",
  diceParseRt.diceLabel({ min: 1, max: 0 }) === "1–0" &&
    diceParseRt.diceLabel({ min: 1, max: -3 }) === "1–-3" &&
    diceParseRt.diceLabel({ min: 1, max: 1 }) === "1–1" &&
    !diceMarkup(tileAgreement.body).includes('class="die-face unrolled">d0</div>') &&
    !diceMarkup(tileAgreement.body).includes('class="die-face unrolled">d-3</div>')
);
check(
  "dice long-number faces clamp their font and hide overflow",
  eqHome.includes("word-break:break-word; overflow:hidden;") &&
    eqHome.includes(".die-face.number-face.die-face-long{font-size:9px;")
);
const workerExports = await import("./src/worker.js");
check("dice URL parser stays module-private", !("dieFromParam" in workerExports));
check(
  "deriveDie uses the dice slug and requested draw index",
  (await deriveDie(V_RAND, V_NONCE, 2, 3, 17)) ===
    3 + (await derivePick(V_RAND, V_NONCE, "dice", 2, 15))
);
check(
  "deriveDie rejects spans wider than 2^32",
  (await deriveDie(V_RAND, V_NONCE, 0, 1, 5000000000)) === null
);

/* 38. shipped dice client protocol --------------------------------------- */
function trackedDiceNode(initialText = "") {
  let html = "";
  let text = String(initialText);
  const node = { className: "" };
  Object.defineProperties(node, {
    innerHTML: {
      get: () => html,
      set: (value) => { html = String(value); text = ""; },
    },
    textContent: {
      get: () => text,
      set: (value) => { text = String(value); html = ""; },
    },
  });
  return node;
}

function fakeDiceButton(attrs = {}) {
  const handlers = {};
  return {
    disabled: false,
    getAttribute: (name) => attrs[name] === undefined ? null : String(attrs[name]),
    addEventListener(type, fn) {
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(fn);
    },
    click() {
      if (this.disabled) return undefined;
      let value;
      for (const fn of handlers.click || []) value = fn({ target: this });
      return value;
    },
  };
}

function fakeDiceTile(min, max) {
  const label = min === 1 && max === 2 ? "coin" : min === 1 && max > min ? "d" + max : min + "–" + max;
  const face = trackedDiceNode(label);
  face.className = "die-face unrolled";
  const caption = trackedDiceNode(label);
  const proof = trackedDiceNode("");
  const reroll = fakeDiceButton();
  const attrs = { "data-min": String(min), "data-max": String(max) };
  return {
    face, caption, proof, reroll,
    getAttribute: (name) => attrs[name] === undefined ? null : attrs[name],
    querySelector: (sel) =>
      sel === ".die-face" ? face :
      sel === ".die-label" ? caption :
      sel === ".proof" ? proof :
      sel === ".dice-reroll" ? reroll : null,
  };
}

function fakeDiceCard(bounds = [], opts = {}) {
  const card = {
    tiles: bounds.map(([min, max]) => fakeDiceTile(min, max)),
    rollAll: fakeDiceButton(),
    presets: (opts.presets || [[1, 6]]).map(([min, max]) =>
      fakeDiceButton({ "data-min": min, "data-max": max })
    ),
    addButton: fakeDiceButton(),
    minInput: { value: opts.customMin === undefined ? "1" : String(opts.customMin), disabled: false },
    maxInput: { value: opts.customMax === undefined ? "6" : String(opts.customMax), disabled: false },
    cap: trackedDiceNode(""),
    err: { hidden: true, textContent: "" },
    _diceBusy: false,
  };
  card.tray = { appendChild: (tile) => { card.tiles.push(tile); return tile; } };
  card.querySelectorAll = (sel) => {
    if (sel === ".die[data-min][data-max]") return card.tiles.slice();
    if (sel === ".dice-roll-control,.dice-preset,.dice-add") {
      return [card.rollAll]
        .concat(card.tiles.map((tile) => tile.reroll), card.presets, [card.addButton]);
    }
    if (sel === ".dice-custom input") return [card.minInput, card.maxInput];
    if (sel === ".dice-preset") return card.presets;
    return [];
  };
  card.querySelector = (sel) =>
    sel === ".dice-roll-all" ? card.rollAll :
    sel === ".dice-tray" ? card.tray :
    sel === ".dice-cap" ? card.cap :
    sel === ".card-err" ? card.err :
    sel === ".dice-add" ? card.addButton :
    sel === ".dice-custom-min" ? card.minInput :
    sel === ".dice-custom-max" ? card.maxInput : null;
  return card;
}

function renderedDiceValue(tile) {
  if (tile.face.className.includes("coin-face")) return tile.face.textContent === "Heads" ? 1 : 2;
  if (tile.face.className.includes("pip-face")) {
    return (tile.face.innerHTML.match(/class="pip pip-/g) || []).length;
  }
  return Number(tile.face.textContent);
}

const DICE_PROTOCOL_FNS = [
  "diceBound", "dieFromElement", "diceTiles", "diceOrdered",
  "clearDieProof", "showDieProof", "pendingDie", "renderDieResult",
  "localDie", "fallbackDie", "setDiceBusy", "errEl", "showErr",
  "rollDiceAll", "rerollDie",
];
function diceProtocolRuntime({
  mintNonce,
  probe = probeBeaconRound,
  waitForRound,
  fetchImpl,
  local = (min) => min,
}) {
  return clientRuntime(eqScript, DICE_PROTOCOL_FNS, {
    randInt: local,
    mintNonce,
    probeBeaconRound: probe,
    fetchBeacon: waitForRound,
    deriveDie,
    BEACON_URL: BEACON_PREFIX,
    fetch: fetchImpl,
  });
}

function loggedBeaconHarness(nonces) {
  const calls = [];
  let nonceIx = 0;
  const beaconFetch = globalThis.fetch;
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return beaconFetch(url);
  };
  return {
    calls,
    fetchImpl,
    mintNonce() {
      const value = nonces[nonceIx] || "nonce-" + (nonceIx + 1);
      nonceIx++;
      return value;
    },
    nonceCount: () => nonceIx,
    latestCount: () => calls.filter((url) => url.split("?")[0] === BEACON_PREFIX + "latest").length,
    async waitForRound(round) {
      const res = await fetchImpl(BEACON_PREFIX + round + "?dice-wait=1");
      if (!res.ok) return null;
      const body = await res.json();
      return body && body.randomness ? String(body.randomness) : null;
    },
  };
}

function proofRound(tile) {
  const m = tile.proof.textContent.match(/round (\d+)/);
  return m ? Number(m[1]) : null;
}

beaconMode = "healthy";
seedBeacon(900000);
const trayHarness = loggedBeaconHarness(["tray-one", "die-two", "tray-three"]);
const trayRt = diceProtocolRuntime({
  mintNonce: trayHarness.mintNonce,
  waitForRound: trayHarness.waitForRound,
  fetchImpl: trayHarness.fetchImpl,
});
const protocolCard = fakeDiceCard([[10, 20], [100, 105], [9, 3]]);
await trayRt.rollDiceAll(protocolCard);
const trayRound1 = 900003;
const trayRandom1 = await beaconRandomness(trayRound1);
const trayExpected1 = await Promise.all([
  deriveDie(trayRandom1, "tray-one", 0, 10, 20),
  deriveDie(trayRandom1, "tray-one", 1, 100, 105),
  deriveDie(trayRandom1, "tray-one", 2, 3, 9),
]);
check(
  "dice roll-all makes exactly one commit and one nonce for n dice",
  trayHarness.latestCount() === 1 && trayHarness.nonceCount() === 1,
  "latest " + trayHarness.latestCount() + ", nonces " + trayHarness.nonceCount()
);
check(
  "dice roll-all derives every die at its tray index, including swapped bounds",
  protocolCard.tiles.every((tile, i) => renderedDiceValue(tile) === trayExpected1[i]) &&
    renderedDiceValue(protocolCard.tiles[2]) >= 3 &&
    renderedDiceValue(protocolCard.tiles[2]) <= 9,
  protocolCard.tiles.map(renderedDiceValue).join(",") + " vs " + trayExpected1.join(",")
);
check(
  "dice roll-all unifies per-die round and nonce provenance",
  protocolCard.tiles.every((tile) =>
    proofRound(tile) === trayRound1 && tile.proof.textContent.includes("nonce tray-one")
  ),
  protocolCard.tiles.map((tile) => tile.proof.textContent).join(" | ")
);
const protocolControls = protocolCard.querySelectorAll(".dice-roll-control,.dice-preset,.dice-add");
check(
  "dice roll-all settles with controls enabled and no error",
  !protocolCard._diceBusy &&
    protocolControls.length > 0 &&
    protocolControls.every((c) => !c.disabled) &&
    protocolCard.err.hidden
);

const peerBeforeReroll = [
  { value: renderedDiceValue(protocolCard.tiles[0]), proof: protocolCard.tiles[0].proof.textContent },
  { value: renderedDiceValue(protocolCard.tiles[2]), proof: protocolCard.tiles[2].proof.textContent },
];
seedBeacon(910000);
await trayRt.rerollDie(protocolCard, protocolCard.tiles[1]);
const rerollRound = 910003;
const rerollExpected = await deriveDie(
  await beaconRandomness(rerollRound), "die-two", 0, 100, 105
);
check(
  "dice per-die re-roll uses a fresh nonce and draw index 0",
  trayHarness.latestCount() === 2 &&
    trayHarness.nonceCount() === 2 &&
    renderedDiceValue(protocolCard.tiles[1]) === rerollExpected &&
    proofRound(protocolCard.tiles[1]) === rerollRound &&
    protocolCard.tiles[1].proof.textContent.includes("nonce die-two"),
  protocolCard.tiles[1].proof.textContent
);
check(
  "dice per-die re-roll leaves peer values and provenance untouched",
  renderedDiceValue(protocolCard.tiles[0]) === peerBeforeReroll[0].value &&
    protocolCard.tiles[0].proof.textContent === peerBeforeReroll[0].proof &&
    renderedDiceValue(protocolCard.tiles[2]) === peerBeforeReroll[1].value &&
    protocolCard.tiles[2].proof.textContent === peerBeforeReroll[1].proof
);

seedBeacon(920000);
await trayRt.rollDiceAll(protocolCard);
const trayRound2 = 920003;
const trayRandom2 = await beaconRandomness(trayRound2);
const trayExpected2 = await Promise.all([
  deriveDie(trayRandom2, "tray-three", 0, 10, 20),
  deriveDie(trayRandom2, "tray-three", 1, 100, 105),
  deriveDie(trayRandom2, "tray-three", 2, 3, 9),
]);
check(
  "dice roll-all after a re-roll uses one fresh commit and re-rolls every die",
  trayHarness.latestCount() === 3 &&
    trayHarness.nonceCount() === 3 &&
    protocolCard.tiles.every((tile, i) => renderedDiceValue(tile) === trayExpected2[i])
);
check(
  "dice roll-all after a re-roll reunifies all badges",
  protocolCard.tiles.every((tile) =>
    proofRound(tile) === trayRound2 && tile.proof.textContent.includes("nonce tray-three")
  )
);

// Exercise signed, zero-minimum, and single-value spans through the shipped
// roll protocol rather than only through server markup.
seedBeacon(925000);
const edgeHarness = loggedBeaconHarness(["edge-spans"]);
const edgeRt = diceProtocolRuntime({
  mintNonce: edgeHarness.mintNonce,
  waitForRound: edgeHarness.waitForRound,
  fetchImpl: edgeHarness.fetchImpl,
});
const edgeCard = fakeDiceCard([[-5, -2], [0, 4], [4, 4], [1, 0], [1, -3]]);
await edgeRt.rollDiceAll(edgeCard);
const edgeRound = 925003;
const edgeRandom = await beaconRandomness(edgeRound);
const edgeExpected = await Promise.all([
  deriveDie(edgeRandom, "edge-spans", 0, -5, -2),
  deriveDie(edgeRandom, "edge-spans", 1, 0, 4),
  deriveDie(edgeRandom, "edge-spans", 2, 4, 4),
  deriveDie(edgeRandom, "edge-spans", 3, 0, 1),
  deriveDie(edgeRandom, "edge-spans", 4, -3, 1),
]);
check(
  "dice roll protocol derives negative, zero-minimum, degenerate, and reversed-shorthand spans",
  edgeCard.tiles.every((tile, i) => renderedDiceValue(tile) === edgeExpected[i]) &&
    edgeExpected[2] === 4 &&
    edgeHarness.latestCount() === 1,
  edgeCard.tiles.map(renderedDiceValue).join(",") + " vs " + edgeExpected.join(",")
);

// A locally-falling-back die keeps its original position in the tray. The
// following eligible die must therefore draw at index 2, not filtered index 1.
seedBeacon(930000);
const mixedHarness = loggedBeaconHarness(["mixed"]);
const mixedRt = diceProtocolRuntime({
  mintNonce: mixedHarness.mintNonce,
  waitForRound: mixedHarness.waitForRound,
  fetchImpl: mixedHarness.fetchImpl,
});
const mixedCard = fakeDiceCard([[10, 20], [1, 5000000000], [30, 40]]);
await mixedRt.rollDiceAll(mixedCard);
const mixedRound = 930003;
const mixedRandom = await beaconRandomness(mixedRound);
const mixedFirst = await deriveDie(mixedRandom, "mixed", 0, 10, 20);
const mixedThird = await deriveDie(mixedRandom, "mixed", 2, 30, 40);
check(
  "dice mixed overflow keeps stable tray draw indices",
  renderedDiceValue(mixedCard.tiles[0]) === mixedFirst &&
    renderedDiceValue(mixedCard.tiles[2]) === mixedThird &&
    mixedHarness.latestCount() === 1 &&
    mixedHarness.nonceCount() === 1,
  mixedCard.tiles.map(renderedDiceValue).join(",")
);
check(
  "dice mixed overflow is local and unverified while peers stay verified",
  mixedCard.tiles[1].proof.innerHTML.includes("unverified") &&
    mixedCard.tiles[0].proof.textContent.includes("nonce mixed") &&
    mixedCard.tiles[2].proof.textContent.includes("nonce mixed")
);

const probesBeforeOverflowReroll = mixedHarness.latestCount();
const noncesBeforeOverflowReroll = mixedHarness.nonceCount();
mixedCard.err.hidden = false;
mixedCard.err.textContent = "old custom-input error";
await mixedRt.rerollDie(mixedCard, mixedCard.tiles[1]);
check(
  "dice overflow re-roll skips beacon and nonce work",
  mixedHarness.latestCount() === probesBeforeOverflowReroll &&
    mixedHarness.nonceCount() === noncesBeforeOverflowReroll &&
    mixedCard.tiles[1].proof.innerHTML.includes("unverified")
);
check(
  "dice overflow re-roll clears a stale card error",
  mixedCard.err.hidden && mixedCard.err.textContent === "",
  JSON.stringify(mixedCard.err)
);

const allOverflowHarness = loggedBeaconHarness(["must-not-mint"]);
const allOverflowRt = diceProtocolRuntime({
  mintNonce: allOverflowHarness.mintNonce,
  waitForRound: allOverflowHarness.waitForRound,
  fetchImpl: allOverflowHarness.fetchImpl,
});
const allOverflowCard = fakeDiceCard([[1, 5000000000], [-1000000000000, 1000000000000]]);
await allOverflowRt.rollDiceAll(allOverflowCard);
check(
  "dice all-overflow roll-all skips the beacon and nonce entirely",
  allOverflowHarness.latestCount() === 0 &&
    allOverflowHarness.nonceCount() === 0 &&
    allOverflowCard.tiles.every((tile) => tile.proof.innerHTML.includes("unverified")) &&
    !allOverflowCard._diceBusy
);

// Probe failure is the existing null convention: local results and visible
// unverified badges, with no card error and no stranded controls.
beaconMode = "down";
seedBeacon(940000);
const downHarness = loggedBeaconHarness(["down-all", "down-one"]);
const downRt = diceProtocolRuntime({
  mintNonce: downHarness.mintNonce,
  waitForRound: downHarness.waitForRound,
  fetchImpl: downHarness.fetchImpl,
});
const downCard = fakeDiceCard([[10, 20], [30, 40]]);
await downRt.rollDiceAll(downCard);
check(
  "dice beacon-down roll-all falls back locally without an error",
  downHarness.latestCount() === 1 &&
    downCard.tiles.every((tile) => tile.proof.innerHTML.includes("unverified")) &&
    downCard.err.hidden &&
    !downCard._diceBusy
);
await downRt.rerollDie(downCard, downCard.tiles[0]);
check(
  "dice beacon-down per-die re-roll also recovers locally",
  downHarness.latestCount() === 2 &&
    downHarness.nonceCount() === 2 &&
    downCard.tiles[0].proof.innerHTML.includes("unverified") &&
    !downCard._diceBusy
);
beaconMode = "healthy";
seedBeacon(950000);

// Hold the commit open to inspect the in-flight state. Only the target die
// enters pending UI, but every roll/mutation control is disabled page-wide.
let releaseHeldProbe;
let heldProbeCalls = 0;
let heldNonces = 0;
const heldProbe = new Promise((resolve) => { releaseHeldProbe = resolve; });
const heldRt = diceProtocolRuntime({
  mintNonce: () => { heldNonces++; return "held"; },
  probe: () => { heldProbeCalls++; return heldProbe; },
  waitForRound: boom("held fetchBeacon"),
  fetchImpl: boom("held fetch"),
});
const heldCard = fakeDiceCard([[10, 20], [30, 40]]);
heldRt.renderDieResult(heldCard.tiles[0], 12);
heldRt.showDieProof(heldCard.tiles[0], { round: 1, nonce: "old-a" });
heldRt.renderDieResult(heldCard.tiles[1], 35);
heldRt.showDieProof(heldCard.tiles[1], { round: 1, nonce: "old-b" });
const heldPeerValue = renderedDiceValue(heldCard.tiles[1]);
const heldPeerProof = heldCard.tiles[1].proof.textContent;
const heldRoll = heldRt.rerollDie(heldCard, heldCard.tiles[0]);
await Promise.resolve();
const controlsDuringWait = heldCard.querySelectorAll(".dice-roll-control,.dice-preset,.dice-add");
check(
  "dice in-flight re-roll disables every roll and mutation control",
  heldCard._diceBusy &&
    controlsDuringWait.length > 0 &&
    controlsDuringWait.every((control) => control.disabled) &&
    heldCard.minInput.disabled &&
    heldCard.maxInput.disabled
);
check(
  "dice in-flight per-die wait changes only the target die",
  heldCard.tiles[0].face.textContent.includes("awaiting beacon") &&
    renderedDiceValue(heldCard.tiles[1]) === heldPeerValue &&
    heldCard.tiles[1].proof.textContent === heldPeerProof
);
const blockedSecondRoll = await heldRt.rollDiceAll(heldCard);
check(
  "dice second roll cannot start while a commit is in flight",
  blockedSecondRoll === false && heldProbeCalls === 1 && heldNonces === 1,
  "probes " + heldProbeCalls + ", nonces " + heldNonces
);
const blockedSecondReroll = await heldRt.rerollDie(heldCard, heldCard.tiles[1]);
check(
  "dice per-die busy guard blocks a second re-roll while a commit is in flight",
  blockedSecondReroll === false && heldProbeCalls === 1 && heldNonces === 1,
  "probes " + heldProbeCalls + ", nonces " + heldNonces
);
releaseHeldProbe(null);
await heldRoll;
const recoveredControls = heldCard.querySelectorAll(".dice-roll-control,.dice-preset,.dice-add");
check(
  "dice controls recover after the in-flight roll settles",
  !heldCard._diceBusy &&
    recoveredControls.length > 0 &&
    recoveredControls.every((c) => !c.disabled) &&
    !heldCard.minInput.disabled &&
    !heldCard.maxInput.disabled
);

const pendingTile = fakeDiceTile(3, 17);
heldRt.pendingDie(pendingTile, 12345);
check(
  "dice pending copy names the committed beacon round",
  pendingTile.face.textContent === "awaiting beacon round 12345…",
  pendingTile.face.textContent
);

// Result forms: coin words, accessible pips, and numbered/degenerate tiles.
const renderCard = fakeDiceCard([[1, 2], [1, 6], [3, 17], [4, 4], [-1000000000000, 1000000000000], [2, 1], [6, 1]]);
heldRt.renderDieResult(renderCard.tiles[0], 1);
check("dice coin value 1 renders Heads", renderCard.tiles[0].face.textContent === "Heads");
heldRt.renderDieResult(renderCard.tiles[0], 2);
check("dice coin value 2 renders Tails", renderCard.tiles[0].face.textContent === "Tails");
heldRt.renderDieResult(renderCard.tiles[1], 4);
check(
  "dice d6 renders four pips with an announced value",
  renderedDiceValue(renderCard.tiles[1]) === 4 &&
    renderCard.tiles[1].face.innerHTML.includes('class="dice-value-label">4</span>') &&
    (renderCard.tiles[1].face.innerHTML.match(/aria-hidden="true"/g) || []).length === 4
);
check(
  "dice d6 pips land at their canonical grid positions",
  renderCard.tiles[1].face.innerHTML ===
    '<span class="dice-value-label">4</span>' +
      [1, 3, 7, 9].map((p) => '<span class="pip pip-' + p + '" aria-hidden="true"></span>').join(""),
  renderCard.tiles[1].face.innerHTML
);
heldRt.renderDieResult(renderCard.tiles[2], 9);
heldRt.renderDieResult(renderCard.tiles[3], 4);
check(
  "dice custom and degenerate dice render numbered tiles",
  renderedDiceValue(renderCard.tiles[2]) === 9 &&
    renderedDiceValue(renderCard.tiles[3]) === 4 &&
    renderCard.tiles[2].face.className.includes("number-face")
);
heldRt.renderDieResult(renderCard.tiles[4], -1000000000000);
check(
  "dice accepted extreme values render with the long-value font clamp",
  renderCard.tiles[4].face.textContent === "-1000000000000" &&
    renderCard.tiles[4].face.className.includes("die-face-long")
);
// Special faces follow the label rule: reversed (2,1)/(6,1) dice keep
// numbered tiles matching their "2–1"/"6–1" captions, not coin or pips.
heldRt.renderDieResult(renderCard.tiles[5], 1);
heldRt.renderDieResult(renderCard.tiles[6], 3);
check(
  "dice reversed-bounds tiles render numbers, matching their unswapped labels",
  renderCard.tiles[5].face.className.includes("number-face") &&
    renderCard.tiles[5].face.textContent === "1" &&
    renderCard.tiles[6].face.className.includes("number-face") &&
    renderCard.tiles[6].face.textContent === "3",
  renderCard.tiles[5].face.className + " / " + renderCard.tiles[6].face.className
);
check(
  "dice result rendering leaves every persistent identity caption unchanged",
  renderCard.tiles.every((tile) => tile.caption.textContent.length > 0) &&
    renderCard.tiles[2].caption.textContent === "3–17" &&
    renderCard.tiles[4].caption.textContent === "-1000000000000–1000000000000"
);
heldRt.showDieProof(renderCard.tiles[2], { round: 777, nonce: "proof-only" });
check(
  "dice provenance is neutral text and does not claim verification or create a deferred link",
  renderCard.tiles[2].proof.textContent === "round 777 · nonce proof-only" &&
    !renderCard.tiles[2].proof.textContent.includes("verified") &&
    !renderCard.tiles[2].proof.innerHTML.includes("/verify")
);

/* 39. client tray mutation and address-bar sync -------------------------- */
function fakeDiceDocument() {
  return {
    createElement() {
      let firstChild = null;
      const wrap = {};
      Object.defineProperties(wrap, {
        innerHTML: {
          set(markup) {
            const m = String(markup).match(/data-min="([^"]+)" data-max="([^"]+)"/);
            firstChild = m ? fakeDiceTile(Number(m[1]), Number(m[2])) : null;
          },
        },
        firstChild: { get: () => firstChild },
      });
      return wrap;
    },
  };
}

const DICE_ADD_FNS = [
  "diceBound", "dieFromElement", "diceTiles", "diceLabel", "diceParam",
  "diceTileMarkup", "syncDiceUrl", "setDiceBusy", "bindDieReroll",
  "addDie", "bindDice",
];
function diceAddRuntime(href, replacements) {
  const calls = [];
  const windowStub = { location: { href } };
  const historyStub = {
    replaceState(state, title, next) { calls.push(next); },
  };
  const rt = clientRuntime(eqScript, DICE_ADD_FNS, {
    esc: (s) => String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    ),
    document: fakeDiceDocument(),
    window: windowStub,
    history: historyStub,
    URL,
    showErr(card, msg) {
      card.err.hidden = !msg;
      card.err.textContent = msg || "";
    },
    rerollDie: () => Promise.resolve(true),
    rollDiceAll: () => Promise.resolve(true),
    ...(replacements || {}),
  });
  return { rt, calls, windowStub };
}

const addEnv = diceAddRuntime("https://random.oddspark.dev/dice/?x=1&d=9-3");
const addCard = fakeDiceCard([[9, 3]], { presets: [[1, 6]], customMin: 3, customMax: 17 });
addEnv.rt.bindDice(addCard);
check(
  "dice initial bind leaves a loaded unswapped URL unchanged",
  addEnv.calls.length === 0 &&
    addCard.tiles[0].getAttribute("data-min") === "9" &&
    addCard.tiles[0].getAttribute("data-max") === "3"
);
addCard.presets[0].click();
check(
  "dice preset add mutates the tray once and syncs ordered repeated d params",
  addCard.tiles.length === 2 &&
    addEnv.calls.length === 1 &&
    addEnv.calls[0] === "/dice/?x=1&d=9-3&d=6",
  addEnv.calls.join(" | ")
);
check(
  "dice newly added preset starts with no proof badge",
  addCard.tiles[1].proof.innerHTML === "" && addCard.tiles[1].proof.textContent === ""
);
addCard.addButton.click();
check(
  "dice custom add preserves rendered bound order and syncs without reload",
  addCard.tiles.length === 3 &&
    addCard.tiles[2].getAttribute("data-min") === "3" &&
    addCard.tiles[2].getAttribute("data-max") === "17" &&
    addEnv.calls[1] === "/dice/?x=1&d=9-3&d=6&d=3-17" &&
    addEnv.windowStub.location.href === "https://random.oddspark.dev/dice/?x=1&d=9-3",
  addEnv.calls.join(" | ")
);

const canonicalEnv = diceAddRuntime("https://random.oddspark.dev/dice/?d=1-6");
const canonicalCard = fakeDiceCard([[1, 6]], { presets: [[1, 2]] });
canonicalEnv.rt.bindDice(canonicalCard);
canonicalCard.presets[0].click();
check(
  "dice next mutation canonicalizes shorthand without rewriting on load",
  canonicalEnv.calls.length === 1 && canonicalEnv.calls[0] === "/dice/?d=6&d=2",
  canonicalEnv.calls[0]
);

const bareEnv = diceAddRuntime("https://random.oddspark.dev/dice/");
const bareCard = fakeDiceCard([[1, 6]], { presets: [[1, 20]] });
bareEnv.rt.bindDice(bareCard);
bareCard.presets[0].click();
check(
  "dice first mutation from bare /dice/ serializes the rendered default d6",
  bareEnv.calls.length === 1 && bareEnv.calls[0] === "/dice/?d=6&d=20",
  bareEnv.calls.join(" | ")
);

let clickedRollAllCard = null;
let clickedRerollCard = null;
let clickedRerollTile = null;
const clickEnv = diceAddRuntime("https://random.oddspark.dev/dice/?d=6", {
  rollDiceAll(card) { clickedRollAllCard = card; return Promise.resolve(true); },
  rerollDie(card, tile) {
    clickedRerollCard = card;
    clickedRerollTile = tile;
    return Promise.resolve(true);
  },
});
const clickCard = fakeDiceCard([[1, 6]]);
clickEnv.rt.bindDice(clickCard);
clickCard.rollAll.click();
clickCard.tiles[0].reroll.click();
check(
  "dice bindDice click-through wires roll-all and per-die re-roll buttons",
  clickedRollAllCard === clickCard &&
    clickedRerollCard === clickCard &&
    clickedRerollTile === clickCard.tiles[0]
);

const surgicalAddEnv = diceAddRuntime("https://random.oddspark.dev/dice/?d=6");
const surgicalAddCard = fakeDiceCard([[1, 6]]);
surgicalAddEnv.rt.bindDice(surgicalAddCard);
surgicalAddCard._diceBusy = true;
for (const control of surgicalAddCard.querySelectorAll(".dice-roll-control,.dice-preset,.dice-add")) {
  control.disabled = true;
}
surgicalAddCard.minInput.disabled = true;
surgicalAddCard.maxInput.disabled = true;
surgicalAddEnv.rt.addDie(surgicalAddCard, { min: 1, max: 8 });
check(
  "dice add during a busy card leaves every roll control disabled",
  surgicalAddCard._diceBusy &&
    surgicalAddCard.rollAll.disabled &&
    surgicalAddCard.presets.every((button) => button.disabled) &&
    surgicalAddCard.addButton.disabled &&
    surgicalAddCard.minInput.disabled &&
    surgicalAddCard.maxInput.disabled
);

const idleAddEnv = diceAddRuntime("https://random.oddspark.dev/dice/?d=abc");
const idleAddCard = fakeDiceCard([]);
idleAddEnv.rt.bindDice(idleAddCard);
idleAddEnv.rt.addDie(idleAddCard, { min: 1, max: 8 });
check(
  "dice add on an idle empty tray enables roll-all",
  !idleAddCard._diceBusy && idleAddCard.tiles.length === 1 && !idleAddCard.rollAll.disabled
);

const capEnv = diceAddRuntime("https://random.oddspark.dev/dice/" + repeatedDiceQuery(24));
const capCard = fakeDiceCard(Array.from({ length: 24 }, () => [1, 6]), { presets: [[1, 20]] });
capEnv.rt.bindDice(capCard);
capCard.err.hidden = false;
capCard.err.textContent = "enter a finite minimum and maximum";
capCard.presets[0].click();
check(
  "dice client refuses a 25th die, clears stale input errors, and leaves the URL alone",
  capCard.tiles.length === 24 &&
    capCard.cap.textContent.includes("tray holds 24") &&
    capCard.err.hidden &&
    capCard.err.textContent === "" &&
    capEnv.calls.length === 0
);

const invalidAddEnv = diceAddRuntime("https://random.oddspark.dev/dice/?d=abc");
const invalidAddCard = fakeDiceCard([], { customMin: "abc", customMax: 6 });
invalidAddEnv.rt.bindDice(invalidAddCard);
invalidAddCard.addButton.click();
check(
  "dice invalid custom add is not a mutation",
  invalidAddCard.tiles.length === 0 &&
    invalidAddEnv.calls.length === 0 &&
    !invalidAddCard.err.hidden &&
    invalidAddCard.rollAll.disabled
);

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
