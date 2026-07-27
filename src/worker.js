/**
 * random.oddspark.dev
 *
 * A shelf of random choosers. Each chooser is a card with a name, a press
 * button, an inline result, and a press count. Five choosers are built in
 * and run entirely in the browser. Visitors can name a new one ("random
 * dinosaur"); Workers AI writes the item list once at creation, a smaller
 * model screens the name first, and the list is quietly regenerated the
 * first time someone presses it on a later UTC day.
 *
 * One file, no build step. Same conventions as oddspark.dev.
 */

/* ------------------------------------------------------------------ *
 * Built-in choosers
 * Defined as data so the homepage grid and the /c/:slug permalinks
 * render them identically. type tells the client script how to play:
 * number | color | shape | list. Built-ins never touch the server and
 * have no press counters.
 * ------------------------------------------------------------------ */

const ANIMALS = [
  "aardvark", "albatross", "alligator", "anteater", "armadillo", "axolotl",
  "badger", "barracuda", "bison", "capybara", "cassowary", "chameleon",
  "cheetah", "chinchilla", "cobra", "cormorant", "crane", "dingo",
  "dolphin", "echidna", "emu", "falcon", "ferret", "flamingo",
  "gazelle", "gecko", "gibbon", "giraffe", "gorilla", "hedgehog",
  "heron", "hippopotamus", "hyena", "ibis", "iguana", "jaguar",
  "jellyfish", "kangaroo", "kingfisher", "koala", "lemur", "leopard",
  "llama", "lobster", "lynx", "manatee", "mantis", "meerkat",
  "mongoose", "narwhal", "ocelot", "octopus", "okapi", "opossum",
  "ostrich", "otter", "pangolin", "pelican", "penguin", "platypus",
  "porcupine", "puffin", "quokka", "raccoon", "salamander", "seahorse",
  "sloth", "tapir", "toucan", "walrus", "wombat", "yak",
];

const SIMPSONS = [
  "Homer Simpson", "Marge Simpson", "Bart Simpson", "Lisa Simpson",
  "Maggie Simpson", "Abe Simpson", "Ned Flanders", "Moe Szyslak",
  "Barney Gumble", "Mr. Burns", "Waylon Smithers", "Krusty the Clown",
  "Sideshow Bob", "Milhouse Van Houten", "Nelson Muntz", "Ralph Wiggum",
  "Chief Wiggum", "Maude Flanders", "Rod Flanders", "Todd Flanders",
  "Apu Nahasapeemapetilon", "Principal Skinner", "Edna Krabappel",
  "Groundskeeper Willie", "Otto Mann", "Comic Book Guy", "Dr. Hibbert",
  "Dr. Nick Riviera", "Lenny Leonard", "Carl Carlson", "Patty Bouvier",
  "Selma Bouvier", "Kent Brockman", "Mayor Quimby", "Professor Frink",
  "Snake Jailbird", "Fat Tony", "Duffman", "Bumblebee Man",
  "Cletus Spuckler", "Brandine Spuckler", "Hans Moleman", "Jasper Beardly",
  "Agnes Skinner", "Martin Prince", "Sherri Mackleberry", "Terri Mackleberry",
  "Jimbo Jones", "Kearney Zzyzwicz", "Dolph Starbeam", "Üter Zörker",
  "Wendell Borton", "Database", "Lewis Clark", "Richard",
  "Troy McClure", "Lionel Hutz", "Sideshow Mel", "Rainier Wolfcastle",
  "Kang", "Kodos", "Itchy", "Scratchy", "Santa's Little Helper",
];

export const BUILTINS = [
  { slug: "number", name: "number", kind: "builtin", type: "number", blurb: "an integer between two bounds, inclusive" },
  { slug: "color", name: "color", kind: "builtin", type: "color", blurb: "a hex color; click the code to copy it" },
  { slug: "shape", name: "shape", kind: "builtin", type: "shape", blurb: "a little polygon, drawn fresh each press" },
  { slug: "animal", name: "animal", kind: "builtin", type: "list", items: ANIMALS, blurb: "one of " + ANIMALS.length + " animals" },
  { slug: "simpsons-character", name: "simpsons character", kind: "builtin", type: "list", items: SIMPSONS, blurb: "one of " + SIMPSONS.length + " springfielders" },
  { slug: "random", name: "random random", kind: "builtin", type: "meta", blurb: "picks a chooser, then picks something from it" },
];

const BUILTIN_MAP = Object.fromEntries(BUILTINS.map((b) => [b.slug, b]));

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

/* The shape the client needs to reason about a chooser. */
function manifestEntry(c) {
  return { slug: c.slug, name: c.name, kind: c.kind, type: c.type };
}

function buildManifest(users) {
  return BUILTINS.map(manifestEntry).concat(users.map(manifestEntry));
}

/* ------------------------------------------------------------------ *
 * Crypto helpers
 * ------------------------------------------------------------------ */

const enc = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input) {
  const data = typeof input === "string" ? enc.encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return bytesToHex(new Uint8Array(sig));
}

// Uniform integer in [0, n) without modulo bias.
function randomIndex(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % n;
}

/* ------------------------------------------------------------------ *
 * Signed cookie: rc_uid = "<16 random bytes hex>.<HMAC-SHA256 hex>"
 * One per visitor; gates the one-creation-per-UTC-day rate limit.
 * COOKIE_FALLBACK_SECRET exists so local dev without the secret still
 * behaves deterministically; set COOKIE_SECRET in production.
 * ------------------------------------------------------------------ */

const COOKIE_FALLBACK_SECRET = "random-choosers-dev-secret";
const COOKIE_MAX_AGE = 31536000; // 1 year

function cookieSecret(env) {
  return env.COOKIE_SECRET || COOKIE_FALLBACK_SECRET;
}

async function issueCookieValue(env) {
  const uid = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return uid + "." + (await hmacHex(cookieSecret(env), uid));
}

async function verifyCookieValue(value, env) {
  if (!value || typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const uid = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^[0-9a-f]{32}$/.test(uid) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const want = await hmacHex(cookieSecret(env), uid);
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? uid : null;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function setCookieHeader(value) {
  return "rc_uid=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + COOKIE_MAX_AGE;
}

// Ensures the visitor carries a valid signed cookie; returns the value in
// flight (existing or freshly minted) plus the Set-Cookie header to send,
// which is null when the arriving cookie already verified.
async function ensureCookie(request, env) {
  const existing = readCookie(request, "rc_uid");
  if (await verifyCookieValue(existing, env)) {
    return { value: existing, header: null };
  }
  const value = await issueCookieValue(env);
  return { value, header: setCookieHeader(value) };
}

/* ------------------------------------------------------------------ *
 * Rate limit: one creation per UTC day per signed cookie.
 * Key: rl:<UTC-date>:<sha256 of the cookie value>, TTL 2 days. The key is
 * written only AFTER a creation succeeds; failures never consume the slot.
 * ------------------------------------------------------------------ */

const RL_TTL = 172800;

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function rateKey(env, cookieValue) {
  return "rl:" + utcDay() + ":" + (await sha256Hex(cookieValue));
}

/* ------------------------------------------------------------------ *
 * Slugs
 * ------------------------------------------------------------------ */

export function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return base || "chooser";
}

async function freeSlug(env, base) {
  let slug = base;
  while (BUILTIN_MAP[slug] || (await env.CHOOSERS.get("c:" + slug))) {
    slug = base.slice(0, 35) + "-" + bytesToHex(crypto.getRandomValues(new Uint8Array(2)));
  }
  return slug;
}

/* ------------------------------------------------------------------ *
 * Workers AI
 *
 * Response-shape note, learned the hard way on oddspark: the gpt-oss
 * models return output ONLY in OpenAI-style out.choices[0].message.content
 * (out.response is useless); llama-style models return out.response as a
 * string OR as an already-parsed object when the content is valid JSON.
 * aiText() normalizes all three to a string. The gpt-oss models are also
 * reasoning models: max_tokens must be 2048, because smaller caps get
 * eaten by the chain of thought and truncate the JSON.
 * ------------------------------------------------------------------ */

const GEN_MODEL = "@cf/openai/gpt-oss-120b";
const SCREEN_MODEL = "@cf/openai/gpt-oss-20b";

function aiText(out) {
  if (!out) return "";
  const choice = out.choices && out.choices[0] && out.choices[0].message;
  let resp;
  if (out.response !== undefined && out.response !== null) resp = out.response;
  else if (out.result !== undefined && out.result !== null) resp = out.result;
  else if (choice && choice.content !== undefined) resp = choice.content;
  if (resp === undefined || resp === null) return "";
  return typeof resp === "string" ? resp : JSON.stringify(resp);
}

function stripFence(s) {
  return s.replace(/```json/gi, "").replace(/```/g, "").trim();
}

// Small static blocklist, checked before any model call. The AI screening
// behind it is the real gate; this just short-circuits the obvious.
const BLOCKLIST =
  /\b(porn|porno|xxx|nsfw|nudes?|sex|erotic|hentai|nazi|hitler|kkk|isis|rape|rapist|doxx?|credit\s*card|ssn|social\s*security|kill\s*(all|yourself)|kys)\b/i;

const SCREEN_SYSTEM = [
  "You moderate names for a public website where anyone can create a 'random X' chooser.",
  "Decide whether the proposed chooser name is acceptable for a general audience.",
  "Reject anything sexual, hateful, harassing, violent, illegal, or that targets a real",
  "private person or solicits personal data (PII). Allow everything else, including the",
  "silly, the dark-adjacent but harmless, and the nonsensical.",
  "",
  'Respond with raw JSON only, no markdown fence: {"allow": true} or {"allow": false, "reason": "short plain reason"}',
].join("\n");

async function screenName(env, name) {
  if (BLOCKLIST.test(name)) {
    return { allow: false, reason: "that name is not allowed" };
  }
  const out = await env.AI.run(SCREEN_MODEL, {
    messages: [
      { role: "system", content: SCREEN_SYSTEM },
      { role: "user", content: 'Chooser name: "' + name + '"' },
    ],
    max_tokens: 2048,
    temperature: 0,
  });
  const raw = stripFence(aiText(out));
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("moderation returned no JSON");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  return {
    allow: parsed.allow === true,
    reason: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "that name is not allowed",
  };
}

const GEN_SYSTEM = [
  "You write item lists for a 'random X' chooser toy.",
  "Given a chooser name, respond with a raw JSON array of 64 distinct items that fit the theme.",
  "Items are nouns or short phrases, at most a few words each.",
  "No numbering, no commentary, no duplicates, no markdown fence. JSON array only.",
].join("\n");

function sanitizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const item = String(raw == null ? "" : raw).trim().slice(0, 48);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function generateList(env, name) {
  const out = await env.AI.run(GEN_MODEL, {
    messages: [
      { role: "system", content: GEN_SYSTEM },
      { role: "user", content: 'Write the item list for a chooser named: "' + name + '"' },
    ],
    max_tokens: 2048,
    temperature: 0.9,
  });
  const raw = stripFence(aiText(out));
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("no JSON array in model output");
  const items = sanitizeItems(JSON.parse(raw.slice(start, end + 1)));
  if (items.length < 8) throw new Error("only " + items.length + " usable items");
  return items;
}

/* ------------------------------------------------------------------ *
 * Press counters: a plain-class Durable Object, single "global" instance.
 * Deliberately NOT extending DurableObject from "cloudflare:workers" so
 * test.mjs can import this file under plain Node.
 * ------------------------------------------------------------------ */

export class Counters {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/hit") {
      const { slug } = await request.json();
      const key = "p:" + slug;
      const count = ((await this.state.storage.get(key)) || 0) + 1;
      await this.state.storage.put(key, count);
      return Response.json({ slug, count });
    }
    if (request.method === "POST" && url.pathname === "/counts") {
      const { slugs } = await request.json();
      const counts = {};
      for (const slug of slugs || []) {
        counts[slug] = (await this.state.storage.get("p:" + slug)) || 0;
      }
      return Response.json({ counts });
    }
    const slug = url.searchParams.get("slug");
    return Response.json({ slug, count: (await this.state.storage.get("p:" + slug)) || 0 });
  }
}

function counterStub(env) {
  return env.COUNTERS.get(env.COUNTERS.idFromName("global"));
}

const JSON_BODY = { "content-type": "application/json" };

// Counter failures must never break a pick or a page render.
async function hitCounter(env, slug) {
  try {
    const res = await counterStub(env).fetch("https://counters/hit", {
      method: "POST",
      headers: JSON_BODY,
      body: JSON.stringify({ slug }),
    });
    const j = await res.json();
    return typeof j.count === "number" ? j.count : null;
  } catch (e) {
    return null;
  }
}

async function fetchCounts(env, slugs) {
  if (!slugs.length) return {};
  try {
    const res = await counterStub(env).fetch("https://counters/counts", {
      method: "POST",
      headers: JSON_BODY,
      body: JSON.stringify({ slugs }),
    });
    const j = await res.json();
    return j.counts || {};
  } catch (e) {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * KV records: c:<slug> -> {slug, name, kind:"user", items, created, listDay}
 * ------------------------------------------------------------------ */

async function getUserChooser(env, slug) {
  const rec = await env.CHOOSERS.get("c:" + slug, { type: "json" });
  if (!rec || !Array.isArray(rec.items) || !rec.items.length) return null;
  return rec;
}

async function listUserChoosers(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.CHOOSERS.list({ prefix: "c:", cursor });
    for (const k of r.keys) {
      const rec = await env.CHOOSERS.get(k.name, { type: "json" });
      if (rec) out.push(rec);
    }
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  out.sort((a, b) => String(a.created || "").localeCompare(String(b.created || "")));
  return out;
}

// Daily refresh: regenerate the list for a chooser whose listDay is stale.
// On any failure the old list is kept; it is never blanked.
async function refreshList(env, slug, name) {
  try {
    const items = await generateList(env, name);
    const rec = await env.CHOOSERS.get("c:" + slug, { type: "json" });
    if (!rec) return;
    rec.items = items;
    rec.listDay = utcDay();
    await env.CHOOSERS.put("c:" + slug, JSON.stringify(rec));
  } catch (e) {
    /* keep the old list */
  }
}

/* ------------------------------------------------------------------ *
 * Turnstile. If TURNSTILE_SECRET is unset, verification is skipped
 * entirely: the documented dev/test bypass.
 * ------------------------------------------------------------------ */

async function verifyTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new URLSearchParams();
  body.set("secret", env.TURNSTILE_SECRET);
  body.set("response", token);
  body.set("remoteip", request.headers.get("cf-connecting-ip") || "");
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const j = await res.json();
    return j.success === true;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Plain-text rendering, for people who reach for curl first
 * ------------------------------------------------------------------ */

function homeAsText(builtins, users, counts) {
  const L = [];
  L.push("  random choosers");
  L.push("  a shelf of buttons that pick things");
  L.push("");
  L.push("  BUILT-IN (these run in your browser)");
  for (const b of builtins) L.push("    " + b.slug.padEnd(22) + b.blurb);
  L.push("");
  L.push("  MADE BY VISITORS");
  if (!users.length) {
    L.push("    none yet");
  }
  for (const u of users) {
    const n = counts[u.slug];
    L.push(
      "    " + u.slug.padEnd(22) + u.name +
      (typeof n === "number" ? "  (" + n + (n === 1 ? " press" : " presses") + ")" : "")
    );
  }
  L.push("");
  L.push("  press one:   POST /api/pick/<slug>");
  L.push("  list them:   GET  /api/choosers");
  L.push("  make one:    open the site in a browser (turnstile + one per day)");
  L.push("");
  return L.join("\n");
}

function chooserAsText(c, origin) {
  const L = [];
  L.push("  " + c.name);
  L.push("  a random chooser");
  L.push("");
  if (c.kind === "builtin") {
    L.push("  built-in; the pick happens in your browser.");
    L.push("  " + c.blurb);
  } else {
    L.push("  " + c.items.length + " items on the list, refreshed daily.");
    L.push("  press it:  curl -X POST " + origin + "/api/pick/" + c.slug);
  }
  L.push("");
  L.push("  permalink: " + origin + "/c/" + c.slug);
  L.push("");
  return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * Page
 *
 * HARD INVARIANT: the client script inside this template literal uses
 * string concatenation ONLY. A backtick or a ${ inside it silently breaks
 * the worker build. Server-side values go in through the ${...} holes of
 * the outer template; the client never gets any of its own.
 * ------------------------------------------------------------------ */

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0B0D10"/><circle cx="16" cy="16" r="3" fill="#C9A227"/><circle cx="16" cy="16" r="9" fill="none" stroke="#6E8FB8" stroke-width="1.5" opacity=".7"/><circle cx="16" cy="16" r="14" fill="none" stroke="#6E8FB8" stroke-width="1" opacity=".3"/></svg>'
  );

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function cardHtml(c, count) {
  const perm = ' <a class="perm" href="/c/' + esc(c.slug) + '" title="permalink">&para;</a>';
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
  let meta = "";
  if (c.kind !== "builtin") {
    meta =
      '<div class="count">' +
      (typeof count === "number" ? count + (count === 1 ? " press" : " presses") : "") +
      "</div>";
  }
  const via = c.type === "meta" ? '<div class="via" aria-live="polite"></div>' : "";
  return (
    '<article class="card" data-slug="' + esc(c.slug) + '" data-kind="' + esc(c.kind) + '"' +
    (c.type ? ' data-type="' + esc(c.type) + '"' : "") +
    ">" +
    "<h2>" + esc(c.name) + perm + "</h2>" +
    '<div class="blurb">' + esc(c.blurb || "a generated list, refreshed daily") + "</div>" +
    controls +
    via +
    '<div class="result" aria-live="polite"><span class="hint">&mdash; press &mdash;</span></div>' +
    '<button class="strike press" type="button">Press</button>' +
    meta +
    '<div class="card-err" hidden></div>' +
    "</article>"
  );
}

function createCardHtml(sitekey) {
  return (
    '<article class="card create-card" id="create-card">' +
    "<h2>new chooser</h2>" +
    '<div class="blurb">name it; a model writes the list, another screens the name. one per day.</div>' +
    '<form id="create-form">' +
    '<input type="text" id="create-name" maxlength="60" required ' +
    'placeholder="random dinosaur" autocomplete="off">' +
    '<div class="cf-turnstile" data-sitekey="' + esc(sitekey) + '" data-theme="dark" data-size="flexible"></div>' +
    '<button class="strike" type="submit" id="create-btn">Create</button>' +
    "</form>" +
    '<div class="create-status" id="create-status"></div>' +
    "</article>"
  );
}

const CSS = `
  :root{
    --void:#0B0D10; --panel:#101419; --rule:#1D242C;
    --text:#C6CFD8; --dim:#67737F; --faint:#3D4750;
    --entropy:#6E8FB8; --gold:#C9A227;
    --mono:"Courier Prime",ui-monospace,SFMono-Regular,Menlo,monospace;
    --serif:"Newsreader",Georgia,serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:var(--void); color:var(--text);
    font-family:var(--mono); font-size:14px; line-height:1.6;
    -webkit-font-smoothing:antialiased;
    display:flex; justify-content:center;
    padding:0 20px 80px;
  }
  .shell{width:100%; max-width:1180px}

  header{
    display:flex; align-items:center; justify-content:space-between;
    gap:16px; padding:22px 0 18px; border-bottom:1px solid var(--rule);
  }
  .mark{font-weight:700; letter-spacing:.14em; text-transform:lowercase; font-size:13px}
  .mark span{color:var(--gold)}
  .tagline{color:var(--faint); font-size:11px; letter-spacing:.1em}
  a{color:var(--entropy); text-decoration:none; border-bottom:1px solid transparent}
  a:hover{border-bottom-color:var(--entropy)}
  a:focus-visible{outline:2px solid var(--entropy); outline-offset:2px}

  .lede{
    font-family:var(--serif); font-size:18px; line-height:1.62;
    color:var(--dim); max-width:660px; margin:34px 0 44px;
  }
  .lede b{color:var(--text); font-weight:500}

  .grid{
    display:grid; gap:14px;
    grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));
  }
  /* the Turnstile widget is ~300px wide and does not shrink below that;
     give its card two tracks whenever the grid has room for them */
  @media (min-width:640px){
    .create-card{grid-column:span 2}
  }

  .card{
    background:var(--panel); border:1px solid var(--rule);
    padding:20px 18px 18px; display:flex; flex-direction:column; gap:12px;
  }
  .card h2{
    font-family:var(--serif); font-weight:400; font-size:22px;
    margin:0; color:#E4EAF0; letter-spacing:-.01em;
  }
  .card h2 .perm{font-family:var(--mono); font-size:13px; color:var(--faint)}
  .card h2 .perm:hover{color:var(--entropy)}
  .blurb{color:var(--faint); font-size:11.5px; letter-spacing:.03em}

  .ctl{display:flex; gap:10px}
  .ctl label{
    display:flex; align-items:center; gap:7px;
    color:var(--dim); font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  }
  .ctl input{
    width:92px; background:var(--void); border:1px solid var(--rule);
    color:var(--text); font-family:var(--mono); font-size:13px; padding:5px 8px;
  }
  .ctl input:focus{outline:1px solid var(--entropy)}

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

  .result{
    min-height:64px; display:flex; align-items:center; justify-content:center;
    border:1px dashed var(--rule); padding:10px; text-align:center;
    font-family:var(--serif); font-size:21px; line-height:1.35; color:#E4EAF0;
    word-break:break-word;
  }
  .result .hint{font-family:var(--mono); font-size:11px; color:var(--faint); letter-spacing:.14em}
  .result .big{font-size:34px; font-variant-numeric:tabular-nums}
  .result .swatch{
    width:100%; height:64px; border:1px solid var(--rule); margin-bottom:8px;
  }
  .result .hexcode{
    font-family:var(--mono); font-size:14px; color:var(--entropy);
    cursor:pointer; letter-spacing:.08em;
  }
  .result .hexcode:hover{border-bottom:1px solid var(--entropy)}
  .result.color-result{flex-direction:column; gap:0}
  .result canvas{display:block; width:100%; height:auto}

  button.strike{
    font-family:var(--mono); font-size:12px; font-weight:700;
    letter-spacing:.22em; text-transform:uppercase;
    color:var(--void); background:var(--gold);
    border:0; padding:12px 24px; cursor:pointer; align-self:flex-start;
    transition:transform .12s ease, filter .12s ease;
  }
  button.strike:hover:not(:disabled){filter:brightness(1.12)}
  button.strike:active:not(:disabled){transform:translateY(1px)}
  button.strike:disabled{opacity:.45; cursor:wait}
  button.strike:focus-visible{outline:2px solid var(--entropy); outline-offset:3px}

  .count{color:var(--faint); font-size:10.5px; letter-spacing:.12em; text-transform:uppercase; min-height:14px}
  .card-err{color:#E06A3F; font-size:12px}
  .card-err[hidden]{display:none}

  .create-card form{display:flex; flex-direction:column; gap:12px}
  .create-card input{
    background:var(--void); border:1px solid var(--rule); color:var(--text);
    font-family:var(--mono); font-size:14px; padding:10px 12px; width:100%;
  }
  .create-card input:focus{outline:1px solid var(--entropy)}
  .create-status{font-size:12px; color:var(--dim); line-height:1.6; min-height:16px}
  .create-status.err{color:#E06A3F}
  .create-status.ok{color:var(--entropy)}

  footer{
    margin-top:44px; padding-top:18px; border-top:1px solid var(--rule);
    display:flex; flex-wrap:wrap; gap:8px 22px; font-size:11px; color:var(--faint);
  }

  .notfound{margin-top:60px}
  .notfound h1{
    font-family:var(--serif); font-weight:400; font-size:31px; color:#E4EAF0;
    margin:0 0 14px;
  }
  .notfound p{font-family:var(--serif); font-size:17px; color:var(--dim)}

  @media (prefers-reduced-motion:reduce){
    *{animation:none !important; transition:none !important}
  }
`;

const CLIENT_SCRIPT = `
(function(){
  var HEX = "0123456789abcdef";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var LISTS = __LISTS__;
  var CHOOSERS = __CHOOSERS__;
  __POOL_FN__
  var SHAPE_COLORS = ["#6E8FB8", "#C9A227", "#E06A3F", "#5E8CA8", "#8FA876", "#B87E9E"];

  console.log(
    "%c random choosers %c press a card, get a thing ",
    "background:#C9A227;color:#0B0D10;font-weight:bold;padding:2px 6px",
    "background:#101419;color:#6E8FB8;padding:2px 6px"
  );

  function esc(s){
    return String(s).replace(/[&<>"]/g, function(c){
      return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c];
    });
  }

  // 53 bits of crypto randomness in [0, 1)
  function rand(){
    var b = new Uint32Array(2);
    crypto.getRandomValues(b);
    var hi = b[0] >>> 5, lo = b[1] >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }
  function randInt(min, max){
    if (max <= min) return min;
    return Math.floor(min + rand() * (max - min + 1));
  }
  function pick(arr){ return arr[Math.floor(rand() * arr.length)]; }

  function scramble(node, finalText){
    if (reduce || !finalText) { node.textContent = finalText || ""; return; }
    var steps = 9, i = 0;
    var t = setInterval(function(){
      i++;
      if (i >= steps) {
        clearInterval(t);
        node.textContent = finalText;
        return;
      }
      var out = "";
      for (var k = 0; k < Math.min(finalText.length, 44); k++) {
        out += finalText[k] === " " ? " " : HEX[Math.floor(Math.random() * 16)];
      }
      node.textContent = out;
    }, 34);
  }

  function resultEl(card){ return card.querySelector(".result"); }
  function errEl(card){ return card.querySelector(".card-err"); }
  function showErr(card, msg){
    var e = errEl(card);
    if (!e) return;
    e.hidden = !msg;
    e.textContent = msg || "";
  }

  function textResult(card, text, big){
    var r = resultEl(card);
    r.className = "result";
    r.innerHTML = '<span class="' + (big ? "big" : "") + '"></span>';
    scramble(r.firstChild, text);
  }

  /* built-in: number ----------------------------------------------- */
  function pressNumber(card){
    var minIn = card.querySelector(".num-min");
    var maxIn = card.querySelector(".num-max");
    var CAP = 1e12;
    function clamped(input, fallback){
      var v = parseFloat(input.value);
      if (!isFinite(v)) v = fallback;
      v = Math.round(v);
      if (v > CAP) v = CAP;
      if (v < -CAP) v = -CAP;
      input.value = v;
      return v;
    }
    var a = clamped(minIn, 1), b = clamped(maxIn, 100);
    if (a > b) { var t = a; a = b; b = t; minIn.value = a; maxIn.value = b; }
    textResult(card, String(randInt(a, b)), true);
  }

  /* built-in: color ------------------------------------------------ */
  function pressColor(card){
    var hex = "#";
    for (var i = 0; i < 6; i++) hex += HEX[randInt(0, 15)];
    var r = resultEl(card);
    r.className = "result color-result";
    r.innerHTML =
      '<div class="swatch" style="background:' + hex + '"></div>' +
      '<span class="hexcode" title="click to copy">' + hex + '</span>';
    var code = r.querySelector(".hexcode");
    code.onclick = function(){
      if (navigator.clipboard) navigator.clipboard.writeText(hex);
      code.textContent = "copied";
      setTimeout(function(){ code.textContent = hex; }, 1200);
    };
  }

  /* built-in: shape ------------------------------------------------ */
  function pressShape(card){
    var r = resultEl(card);
    r.className = "result";
    var cv = r.querySelector("canvas");
    if (!cv) {
      r.innerHTML = "";
      cv = document.createElement("canvas");
      cv.width = 480; cv.height = 300;
      r.appendChild(cv);
    }
    var ctx = cv.getContext("2d");
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    var n = randInt(3, 9);
    var cx = W / 2, cy = H / 2, base = Math.min(W, H) * 0.36;
    var color = pick(SHAPE_COLORS);
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2 + rand() * 0.35;
      var rad = base * (0.45 + rand() * 0.75);
      var x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    if (rand() < 0.5) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 + rand() * 4;
      ctx.stroke();
    }
  }

  /* built-in: list ------------------------------------------------- */
  function pressList(card, slug){
    var items = LISTS[slug] || [];
    if (!items.length) { showErr(card, "no list loaded"); return; }
    textResult(card, pick(items), false);
  }

  /* user chooser: server pick -------------------------------------- */
  function pressKv(card, slug, btn){
    btn.disabled = true;
    fetch("/api/pick/" + encodeURIComponent(slug), { method: "POST" })
      .then(function(res){
        return res.json().then(function(j){ return { ok: res.ok, j: j }; });
      })
      .then(function(r){
        if (!r.ok) throw new Error(r.j && r.j.error ? r.j.error : "HTTP error");
        textResult(card, r.j.item, false);
        var c = card.querySelector(".count");
        if (c && typeof r.j.count === "number") {
          c.textContent = r.j.count + (r.j.count === 1 ? " press" : " presses");
        }
      })
      .catch(function(e){
        showErr(card, "no pick: " + e.message);
      })
      .finally(function(){
        btn.disabled = false;
      });
  }

  function bindCard(card){
    var btn = card.querySelector("button.press");
    if (!btn) return;
    var slug = card.getAttribute("data-slug");
    var kind = card.getAttribute("data-kind");
    var type = card.getAttribute("data-type");
    btn.addEventListener("click", function(){
      showErr(card, "");
      if (kind === "builtin") {
        if (type === "number") pressNumber(card);
        else if (type === "color") pressColor(card);
        else if (type === "shape") pressShape(card);
        else pressList(card, slug);
      } else {
        pressKv(card, slug, btn);
      }
    });
  }

  var cards = document.querySelectorAll(".card[data-slug]");
  for (var i = 0; i < cards.length; i++) bindCard(cards[i]);

  /* create form ----------------------------------------------------- */
  var form = document.getElementById("create-form");
  if (form) {
    var status = document.getElementById("create-status");
    var createBtn = document.getElementById("create-btn");
    var nameInput = document.getElementById("create-name");
    form.addEventListener("submit", function(ev){
      ev.preventDefault();
      var name = nameInput.value.trim();
      if (!name) return;
      var tokenField = form.querySelector('[name="cf-turnstile-response"]');
      var token = tokenField ? tokenField.value : "";
      createBtn.disabled = true;
      status.className = "create-status";
      status.textContent = "verifying and generating the list; this can take 30-60 seconds. hold on.";
      fetch("/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name, "cf-turnstile-response": token })
      })
        .then(function(res){
          return res.json().then(function(j){ return { status: res.status, j: j }; });
        })
        .then(function(r){
          if (r.status === 200 && r.j.slug) {
            status.className = "create-status ok";
            status.innerHTML =
              'made it: <a href="/c/' + esc(r.j.slug) + '">/c/' + esc(r.j.slug) + "</a>";
            appendCard(r.j.slug, r.j.name);
            nameInput.value = "";
          } else if (r.status === 429) {
            status.className = "create-status err";
            status.textContent = r.j.error || "one new chooser per day; come back tomorrow";
          } else if (r.status === 403) {
            status.className = "create-status err";
            status.textContent = "rejected: " + (r.j.error || "not allowed");
          } else {
            status.className = "create-status err";
            status.textContent = r.j.error || "creation failed; try again";
          }
        })
        .catch(function(e){
          status.className = "create-status err";
          status.textContent = "creation failed: " + e.message;
        })
        .finally(function(){
          createBtn.disabled = false;
          if (window.turnstile) {
            try { window.turnstile.reset(); } catch (e) {}
          }
        });
    });
  }

  function appendCard(slug, name){
    var grid = document.querySelector(".grid");
    var createCard = document.getElementById("create-card");
    if (!grid) return;
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<article class="card" data-slug="' + esc(slug) + '" data-kind="user">' +
      "<h2>" + esc(name) + ' <a class="perm" href="/c/' + esc(slug) + '" title="permalink">&para;</a></h2>' +
      '<div class="blurb">a generated list, refreshed daily</div>' +
      '<div class="result" aria-live="polite"><span class="hint">&mdash; press &mdash;</span></div>' +
      '<button class="strike press" type="button">Press</button>' +
      '<div class="count">0 presses</div>' +
      '<div class="card-err" hidden></div>' +
      "</article>";
    var card = wrap.firstChild;
    grid.insertBefore(card, createCard || null);
    bindCard(card);
  }
})();
`;

function page(opts) {
  const title = opts.title;
  const desc = opts.desc;
  const canonical = opts.canonical;
  const listsJson = JSON.stringify({
    animal: ANIMALS,
    "simpsons-character": SIMPSONS,
  }).replace(/</g, "\\u003c");
  const ldJson = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "random choosers",
    url: "https://random.oddspark.dev/",
    description:
      "A shelf of random choosers: number, color, shape, animal, simpsons character, plus choosers named by visitors with AI-generated lists.",
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="random choosers">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<script type="application/ld+json">${ldJson}</script>
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap" rel="stylesheet">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
<style>${CSS}</style>
</head>
<body>
<div class="shell">

  <header>
    <div class="mark"><a href="/" style="color:inherit;border:0">random<span> choosers</span></a></div>
    <div class="tagline">press a card, get a thing</div>
  </header>

  ${opts.lede ? '<p class="lede">' + esc(opts.lede) + "</p>" : ""}

  <div class="grid">
    ${opts.cards}
    ${opts.showCreate ? createCardHtml(opts.sitekey) : ""}
  </div>

  <footer>
    <a href="/api/choosers">json</a>
    <span>random.oddspark.dev</span>
    <span>built-ins run in your browser; the rest are one press each</span>
  </footer>

</div>

<script>${CLIENT_SCRIPT
  .replace("__LISTS__", function () { return listsJson; })
  .replace("__CHOOSERS__", function () { return JSON.stringify(opts.choosers || []); })
  .replace("__POOL_FN__", function () { return computePool.toString(); })}</script>
</body>
</html>`;
}

function notFoundPage(slug) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>no such chooser / random choosers</title>
<meta name="robots" content="noindex">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="mark"><a href="/" style="color:inherit;border:0">random<span> choosers</span></a></div>
    <div class="tagline">press a card, get a thing</div>
  </header>
  <div class="notfound">
    <h1>No chooser called &ldquo;${esc(slug)}&rdquo;.</h1>
    <p>It was never made, or the link is off. The shelf is <a href="/">this way</a>.</p>
  </div>
</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extraHeaders },
  });
}

function wantsText(req) {
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  const accept = req.headers.get("accept") || "";
  if (/^(curl|wget|httpie|http)\b/.test(ua)) return true;
  return !accept.includes("text/html") && !accept.includes("*/*");
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "expected a JSON body: {name}" }, 400);
  }
  const name = String((body && body.name) || "").trim();
  if (!name) return json({ error: "name is required" }, 400);
  if (name.length > 60) return json({ error: "name must be 60 characters or fewer" }, 400);

  // 1. signed cookie
  const cookieValue = readCookie(request, "rc_uid");
  if (!(await verifyCookieValue(cookieValue, env))) {
    return json({ error: "no valid session cookie; load the homepage first" }, 400);
  }

  // 2. turnstile (skipped when TURNSTILE_SECRET is unset)
  if (!(await verifyTurnstile(request, env, body["cf-turnstile-response"]))) {
    return json({ error: "turnstile verification failed" }, 403);
  }

  // 3. rate limit: one creation per UTC day per cookie
  const rl = await rateKey(env, cookieValue);
  if (await env.CHOOSERS.get(rl)) {
    return json({ error: "one new chooser per day; come back tomorrow" }, 429);
  }

  // 4. screening, then 5. list generation
  let verdict;
  try {
    verdict = await screenName(env, name);
  } catch (e) {
    return json({ error: "moderation unavailable; try again shortly" }, 502);
  }
  if (!verdict.allow) {
    return json({ error: verdict.reason }, 403);
  }

  let items;
  try {
    items = await generateList(env, name);
  } catch (e) {
    return json({ error: "could not generate a list for that name; try another" }, 502);
  }

  // 6. store, then consume the day's rate slot
  const slug = await freeSlug(env, slugify(name));
  const rec = {
    slug,
    name,
    kind: "user",
    items,
    created: new Date().toISOString(),
    listDay: utcDay(),
  };
  await env.CHOOSERS.put("c:" + slug, JSON.stringify(rec));
  await env.CHOOSERS.put(rl, "1", { expirationTtl: RL_TTL });

  return json({ slug, name });
}

async function handlePick(request, env, ctx, slug) {
  const rec = await getUserChooser(env, slug);
  if (!rec) {
    if (BUILTIN_MAP[slug]) {
      return json({ error: "built-in choosers run in the browser; no server pick" }, 400);
    }
    return json({ error: "no chooser with that slug" }, 404);
  }
  const item = rec.items[randomIndex(rec.items.length)];
  const count = await hitCounter(env, slug);

  // Stale list? Regenerate in the background; the press returns now.
  if (rec.listDay !== utcDay() && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(refreshList(env, slug, rec.name));
  }

  return json({ slug, name: rec.name, item, count });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = url.origin;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      /* API ------------------------------------------------------- */

      if (path === "/api/create" && request.method === "POST") {
        return await handleCreate(request, env);
      }

      if (path.startsWith("/api/pick/") && request.method === "POST") {
        const slug = decodeURIComponent(path.split("/").pop() || "").toLowerCase();
        return await handlePick(request, env, ctx, slug);
      }

      if (path === "/api/choosers") {
        const users = await listUserChoosers(env);
        return json([
          ...BUILTINS.map((b) => ({ slug: b.slug, name: b.name, kind: "builtin" })),
          ...users.map((u) => ({ slug: u.slug, name: u.name, kind: "user" })),
        ]);
      }

      /* Permalink ------------------------------------------------- */

      if (path.startsWith("/c/")) {
        const slug = decodeURIComponent(path.split("/").pop() || "").toLowerCase();
        const builtin = BUILTIN_MAP[slug];
        const rec = builtin || (await getUserChooser(env, slug));
        if (!rec) {
          if (wantsText(request)) return text("no chooser called " + slug + "\n", 404);
          return html(notFoundPage(slug), 404);
        }
        if (wantsText(request)) return text(chooserAsText(rec, origin));
        const counts = builtin ? {} : await fetchCounts(env, [slug]);
        // Only the meta chooser needs the whole shelf; every other
        // permalink stays at its current single-lookup cost.
        const choosers =
          rec.slug === "random" ? buildManifest(await listUserChoosers(env)) : [];
        const cookie = await ensureCookie(request, env);
        const headers = { "cache-control": "no-store" };
        if (cookie.header) headers["set-cookie"] = cookie.header;
        return html(
          page({
            title: rec.name + " / random choosers",
            desc: "Press the button; get a random " + rec.name + ".",
            canonical: "https://random.oddspark.dev/c/" + rec.slug,
            cards: cardHtml(rec, counts[slug]),
            choosers,
            showCreate: false,
            sitekey: env.TURNSTILE_SITE_KEY || "",
          }),
          200,
          headers
        );
      }

      /* Home ------------------------------------------------------ */

      if (path === "/") {
        const users = await listUserChoosers(env);
        const counts = await fetchCounts(env, users.map((u) => u.slug));
        if (wantsText(request)) return text(homeAsText(BUILTINS, users, counts));
        const cookie = await ensureCookie(request, env);
        const headers = { "cache-control": "no-store" };
        if (cookie.header) headers["set-cookie"] = cookie.header;
        const cards =
          BUILTINS.map((b) => cardHtml(b)).join("\n") +
          "\n" +
          users.map((u) => cardHtml(u, counts[u.slug])).join("\n");
        return html(
          page({
            title: "random choosers",
            desc: "A shelf of random choosers. Press a card, get a thing. Name your own and a model writes the list.",
            canonical: "https://random.oddspark.dev/",
            lede: "Every card is a button. The built-ins roll in your browser; the rest were named by visitors, with lists written by a model and refreshed daily. One new chooser per person per day.",
            cards,
            choosers: buildManifest(users),
            showCreate: true,
            sitekey: env.TURNSTILE_SITE_KEY || "",
          }),
          200,
          headers
        );
      }

      return new Response("404", { status: 404 });
    } catch (err) {
      if (path.startsWith("/api/")) return json({ error: String(err.message || err) }, 502);
      return new Response("something broke: " + (err.message || err), { status: 502 });
    }
  },
};
