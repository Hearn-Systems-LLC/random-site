/**
 * random.oddspark.dev
 *
 * A shelf of random choosers. Each chooser is a card with a name, a press
 * button, an inline result, and a press count. Five choosers are built in
 * and run entirely in the browser. Visitors can name a new one ("random
 * dinosaur"); Workers AI writes the item list once at creation — the full
 * category, capped at 200 items — a smaller model screens the name first,
 * and the stored list never changes again, so every pick on it stays
 * verifiable forever.
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
  // The meta chooser leads: it picks among all the others, so it reads as
  // the shelf's header rather than a peer of the cards below it.
  { slug: "random", name: "random random", kind: "builtin", type: "meta", blurb: "picks a chooser, then picks something from it" },
  { slug: "number", name: "number", kind: "builtin", type: "number", blurb: "an integer between two bounds, inclusive" },
  { slug: "color", name: "color", kind: "builtin", type: "color", blurb: "a hex color; click the code to copy it" },
  { slug: "shape", name: "shape", kind: "builtin", type: "shape", blurb: "a little polygon, drawn fresh each press" },
  { slug: "animal", name: "animal", kind: "builtin", type: "list", items: ANIMALS, blurb: "one of " + ANIMALS.length + " animals" },
  { slug: "simpsons-character", name: "simpsons character", kind: "builtin", type: "list", items: SIMPSONS, blurb: "one of " + SIMPSONS.length + " springfielders" },
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
    if (c.slug === "random" || c.type === "meta") continue;
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

/* Shared by the canvas the browser draws and the sentence the server
   returns to curl, so the two never drift. Injected into the client
   script via __SHAPE_COLORS__ the same way LISTS and CHOOSERS are. */
export const SHAPE_COLORS = ["#6E8FB8", "#C9A227", "#E06A3F", "#5E8CA8", "#8FA876", "#B87E9E"];

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
 * Verifiable randomness: drand quicknet commit-reveal
 *
 * Every pick commits to a beacon round plus a fresh 8-byte nonce minted
 * at commit time, waits for the round to be published, and derives the
 * pick deterministically:
 *
 *   seed = sha256hex(randomness + ":" + nonce + ":" + slug + ":" + drawIx)
 *
 * walked as eight uint32 words with the same rejection sampling as
 * randomIndex (on exhaustion, rehash seed + ":" + k for k = 0, 1, ...).
 *
 * Draw scheme per chooser type. base is 0 for a direct pick and 1 when a
 * meta pick already spent draw 0 choosing the chooser:
 *   number: base      -> index in [0, max-min+1); item = min + index
 *   color:  base..+5  -> one hex digit each, [0, 16)
 *   shape:  base      -> sides [0, 7) + 3; base+1 -> palette index;
 *           base+2    -> filled [0, 2). Angle/radius jitter in the
 *           drawing stays cosmetic and is no part of the item.
 *   list:   base      -> index in [0, items.length)
 *   meta:   0         -> pool index (slug "random"), then the item draws
 *           above at base 1 against the chosen chooser's slug.
 *   dice:   tray die i -> index i with slug "dice"; a per-die re-roll
 *           uses index 0 with the same slug.
 *
 * derivePick, deriveDie, deriveItem and probeBeaconRound are written in the client
 * script's dialect (var / function, no const or arrows) and deliberately
 * self-contained -- no module-scope reads -- because their SOURCE TEXT
 * is injected into the browser via .toString() (the computePool /
 * __POOL_FN__ pattern), so the homepage, the server and the /verify
 * page run byte-identical logic. That is why the chain parameters are
 * inlined as literals inside the first two (the probe takes its base
 * URL as an argument). beaconRoundForTime/beaconPublishTime keep the
 * same dialect but are used module-side only (round math and tests).
 * ------------------------------------------------------------------ */

const BEACON_CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const BEACON_URL = "https://drand.cloudflare.com/" + BEACON_CHAIN + "/public/";

// Polling cadence, mutable so tests can shrink it; production keeps the
// documented ~1s interval and ~18s cap.
export const beaconTiming = { intervalMs: 1000, capMs: 18000 };

// The first round of drand quicknet (genesis 1692803367, 3s period) not
// yet published at nowMs: the round of the 3-second window starting now.
// NOTE: not the commit target -- see probeBeaconRound. Kept for the
// round/publish-time math and tests.
export function beaconRoundForTime(nowMs) {
  return Math.floor((Math.floor(nowMs / 1000) - 1692803367) / 3) + 1;
}

// Nominal publication instant of a round, in seconds. The gateway in
// fact emits ahead of this schedule by an amount that varies wildly
// across anycast backends (measured 2026-07-28: +1 to +14 rounds),
// which is exactly why the commit target is probed, not computed.
export function beaconPublishTime(round) {
  return 1692803367 + (round - 1) * 3;
}

// Deterministic uniform index in [0, n) from beacon randomness. Returns
// a promise; null when n exceeds 2^32, which 32-bit hash words cannot
// draw from (callers fall back to a local pick, badged unverified).
export function derivePick(randomness, nonce, slug, drawIx, n) {
  if (!(n > 1)) return Promise.resolve(0);
  if (n > 4294967296) return Promise.resolve(null);
  var input = randomness + ":" + nonce + ":" + slug + ":" + drawIx;
  var limit = Math.floor(4294967296 / n) * n;
  function hashHex(s) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function (buf) {
      var b = new Uint8Array(buf);
      var hex = "";
      for (var i = 0; i < b.length; i++) hex += (b[i] < 16 ? "0" : "") + b[i].toString(16);
      return hex;
    });
  }
  function attempt(seed, k) {
    return hashHex(k < 0 ? seed : seed + ":" + k).then(function (hex) {
      for (var i = 0; i < 8; i++) {
        var x = parseInt(hex.substr(i * 8, 8), 16);
        if (x < limit) return x % n;
      }
      return attempt(seed, k + 1);
    });
  }
  return attempt(input, -1);
}

// A deterministic die result for already-ordered inclusive bounds. Dice
// always use the shared "dice" seed slug; roll-all supplies the die's tray
// index, while a per-die re-roll supplies 0. Spans wider than a uint32 draw
// return null so the client can use the established local fallback.
export function deriveDie(randomness, nonce, drawIx, min, max) {
  var span = max - min + 1;
  if (span > 4294967296) return Promise.resolve(null);
  return derivePick(randomness, nonce, "dice", drawIx, span).then(function (i) {
    return i === null ? null : min + i;
  });
}

// The deterministic counterpart of builtinPick: same item strings, drawn
// from beacon randomness instead of crypto.getRandomValues. c carries
// {type, items?, min?, max?}; palette is the shared SHAPE_COLORS. Draw
// indices follow the scheme documented above.
export function deriveItem(c, palette, randomness, nonce, slug, base) {
  if (c.type === "number") {
    var a = typeof c.min === "number" ? c.min : 1;
    var b = typeof c.max === "number" ? c.max : 100;
    return derivePick(randomness, nonce, slug, base, b - a + 1).then(function (i) {
      return i === null ? null : String(a + i);
    });
  }
  if (c.type === "color") {
    var digits = [];
    for (var i = 0; i < 6; i++) digits.push(derivePick(randomness, nonce, slug, base + i, 16));
    return Promise.all(digits).then(function (ix) {
      var HEXC = "0123456789abcdef";
      var hex = "#";
      for (var k = 0; k < 6; k++) hex += HEXC[ix[k]];
      return hex;
    });
  }
  if (c.type === "shape") {
    return Promise.all([
      derivePick(randomness, nonce, slug, base, 7),
      derivePick(randomness, nonce, slug, base + 1, palette.length),
      derivePick(randomness, nonce, slug, base + 2, 2),
    ]).then(function (r) {
      var sides = 3 + r[0];
      var color = palette[r[1]];
      var filled = r[2] === 0;
      // "an 8-sided polygon" -- eight is the only vertex count in 3..9
      // that takes "an", since the article follows the spoken digit.
      var article = sides === 8 ? "an " : "a ";
      return article + sides + "-sided polygon in " + color + (filled ? ", filled" : ", outlined");
    });
  }
  if (c.type === "list" && c.items && c.items.length) {
    return derivePick(randomness, nonce, slug, base, c.items.length).then(function (i) {
      return i === null ? null : c.items[i];
    });
  }
  return Promise.resolve(null);
}

// Probe-forward commit target. The gateway's publication horizon is
// inconsistent across anycast backends (measured: +1 to +14 rounds ahead
// of the genesis schedule, and 404s get cached ~27s), so no computed
// round is reliably unpublished at commit time. Instead: seed from
// /public/latest, then probe the next 10 rounds IN PARALLEL with
// cache-busted requests and commit to the lowest 404 -- the first round
// this gateway path will not serve yet. Parallel, not sequential: some
// backends HOLD a frontier request for a full period (~3s, measured)
// until the round is produced, so a sequential walk chases the moving
// frontier forever (measured: 10 probes, ~30s, zero 404s); in parallel
// only the immediate next round(s) hold and the rest 404 at once.
// Documented caveat: a DIFFERENT backend may already serve the committed
// round; the guarantee is "unpublished on the path this press is using".
// All-200 (long-poll backends produced every probed round) commits to
// the last probed round + 1 with the poll cap as backstop; all-errors
// (or a /public/latest failure) returns null and callers fall back to a
// local pick, badged "unverified". Probes AND the /public/latest seed
// time out at 6s, so a blackholed connection cannot hang a press.
//
// Written in the client script's dialect and self-contained (baseUrl and
// fetch come in as arguments): its source ships to the browser via
// DERIVE_FNS_SRC below, so server and browser probe identically.
export function probeBeaconRound(baseUrl, fetchImpl) {
  var doFetch = fetchImpl || fetch;
  var attempt = 0;
  function bust(url) {
    return doFetch(url + (url.indexOf("?") === -1 ? "?" : "&") + "p=" + attempt++);
  }
  // HTTP status of one probed round; 0 on network error, -1 on timeout.
  function statusOf(round) {
    return Promise.race([
      bust(baseUrl + round).then(function (res) {
        var status = res.status;
        return res.arrayBuffer().then(
          function () { return status; },
          function () { return status; }
        );
      }, function () { return 0; }),
      new Promise(function (resolve) { setTimeout(function () { resolve(-1); }, 6000); }),
    ]);
  }
  // The seed fetch gets the same 6s backstop as the probes: a blackholed
  // connection (content blocker, VPN, filtered DNS) must fall back to a
  // local pick, not pin the card on "awaiting beacon" forever.
  return Promise.race([
    bust(baseUrl + "latest").then(function (res) {
      if (!res.ok) return null;
      return res.json().then(function (j) {
        if (!j || typeof j.round !== "number") return null;
        return j.round + 1;
      });
    }, function () { return null; }),
    new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 6000); }),
  ])
    .then(function (start) {
      if (start === null) return null;
      var probes = [];
      for (var k = 0; k < 10; k++) probes.push(statusOf(start + k));
      return Promise.all(probes).then(function (statuses) {
        var served = 0;
        for (var i = 0; i < statuses.length; i++) {
          if (statuses[i] === 404) return start + i; // lowest round this path will not serve
          if (statuses[i] === 200) served++;
        }
        // Every probe served (long-poll backends): commit past the bound.
        // Every probe failed: the gateway is unreachable for us.
        return served > 0 ? start + 10 : null;
      });
    })
    .catch(function () {
      return null;
    });
}

// The injected bundle: homepage client script and /verify page both get
// this verbatim, so derivation cannot drift between press and verify.
// beaconRoundForTime/beaconPublishTime stay module-side (tests only) --
// the client commits via the probe, never the schedule.
//
// It is a STRING, not fn.toString(), on purpose: the worker is bundled by
// esbuild in both `wrangler dev` and `wrangler deploy`, and the bundler
// rewrites nested function declarations with its keepNames __name helper
// (`__name(bust, "bust")` and friends). __name does not exist in the
// browser, so every toString-injected press died with "Uncaught
// ReferenceError: __name is not defined", thrown synchronously before the
// promise chain could catch it -- the 2026-07-29 "awaiting beacon
// forever" bug. A string literal survives bundling untouched. The test
// suite asserts this string is byte-identical to the module functions'
// sources, so the two copies cannot drift silently. Keep them in sync.
// (Exported through a function because workerd rejects non-function
// module exports.)
const DERIVE_FNS_SRC_TEXT = `function derivePick(randomness, nonce, slug, drawIx, n) {
  if (!(n > 1)) return Promise.resolve(0);
  if (n > 4294967296) return Promise.resolve(null);
  var input = randomness + ":" + nonce + ":" + slug + ":" + drawIx;
  var limit = Math.floor(4294967296 / n) * n;
  function hashHex(s) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then(function (buf) {
      var b = new Uint8Array(buf);
      var hex = "";
      for (var i = 0; i < b.length; i++) hex += (b[i] < 16 ? "0" : "") + b[i].toString(16);
      return hex;
    });
  }
  function attempt(seed, k) {
    return hashHex(k < 0 ? seed : seed + ":" + k).then(function (hex) {
      for (var i = 0; i < 8; i++) {
        var x = parseInt(hex.substr(i * 8, 8), 16);
        if (x < limit) return x % n;
      }
      return attempt(seed, k + 1);
    });
  }
  return attempt(input, -1);
}
function deriveDie(randomness, nonce, drawIx, min, max) {
  var span = max - min + 1;
  if (span > 4294967296) return Promise.resolve(null);
  return derivePick(randomness, nonce, "dice", drawIx, span).then(function (i) {
    return i === null ? null : min + i;
  });
}
function deriveItem(c, palette, randomness, nonce, slug, base) {
  if (c.type === "number") {
    var a = typeof c.min === "number" ? c.min : 1;
    var b = typeof c.max === "number" ? c.max : 100;
    return derivePick(randomness, nonce, slug, base, b - a + 1).then(function (i) {
      return i === null ? null : String(a + i);
    });
  }
  if (c.type === "color") {
    var digits = [];
    for (var i = 0; i < 6; i++) digits.push(derivePick(randomness, nonce, slug, base + i, 16));
    return Promise.all(digits).then(function (ix) {
      var HEXC = "0123456789abcdef";
      var hex = "#";
      for (var k = 0; k < 6; k++) hex += HEXC[ix[k]];
      return hex;
    });
  }
  if (c.type === "shape") {
    return Promise.all([
      derivePick(randomness, nonce, slug, base, 7),
      derivePick(randomness, nonce, slug, base + 1, palette.length),
      derivePick(randomness, nonce, slug, base + 2, 2),
    ]).then(function (r) {
      var sides = 3 + r[0];
      var color = palette[r[1]];
      var filled = r[2] === 0;
      // "an 8-sided polygon" -- eight is the only vertex count in 3..9
      // that takes "an", since the article follows the spoken digit.
      var article = sides === 8 ? "an " : "a ";
      return article + sides + "-sided polygon in " + color + (filled ? ", filled" : ", outlined");
    });
  }
  if (c.type === "list" && c.items && c.items.length) {
    return derivePick(randomness, nonce, slug, base, c.items.length).then(function (i) {
      return i === null ? null : c.items[i];
    });
  }
  return Promise.resolve(null);
}
function probeBeaconRound(baseUrl, fetchImpl) {
  var doFetch = fetchImpl || fetch;
  var attempt = 0;
  function bust(url) {
    return doFetch(url + (url.indexOf("?") === -1 ? "?" : "&") + "p=" + attempt++);
  }
  // HTTP status of one probed round; 0 on network error, -1 on timeout.
  function statusOf(round) {
    return Promise.race([
      bust(baseUrl + round).then(function (res) {
        var status = res.status;
        return res.arrayBuffer().then(
          function () { return status; },
          function () { return status; }
        );
      }, function () { return 0; }),
      new Promise(function (resolve) { setTimeout(function () { resolve(-1); }, 6000); }),
    ]);
  }
  // The seed fetch gets the same 6s backstop as the probes: a blackholed
  // connection (content blocker, VPN, filtered DNS) must fall back to a
  // local pick, not pin the card on "awaiting beacon" forever.
  return Promise.race([
    bust(baseUrl + "latest").then(function (res) {
      if (!res.ok) return null;
      return res.json().then(function (j) {
        if (!j || typeof j.round !== "number") return null;
        return j.round + 1;
      });
    }, function () { return null; }),
    new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 6000); }),
  ])
    .then(function (start) {
      if (start === null) return null;
      var probes = [];
      for (var k = 0; k < 10; k++) probes.push(statusOf(start + k));
      return Promise.all(probes).then(function (statuses) {
        var served = 0;
        for (var i = 0; i < statuses.length; i++) {
          if (statuses[i] === 404) return start + i; // lowest round this path will not serve
          if (statuses[i] === 200) served++;
        }
        // Every probe served (long-poll backends): commit past the bound.
        // Every probe failed: the gateway is unreachable for us.
        return served > 0 ? start + 10 : null;
      });
    })
    .catch(function () {
      return null;
    });
}`;

// workerd only accepts function/ExportedHandler module exports, so the
// string above is reachable to tests (and nothing else) through this.
export function deriveFnsSrc() {
  return DERIVE_FNS_SRC_TEXT;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll the beacon until the committed round is published; returns its
// randomness hex, or null after the cap (callers fall back to a local
// pick badged "unverified"). Never throws.
//
// The per-attempt query busts the gateway's per-node caches: a first 404
// is cached ~27s on some anycast nodes (measured 2026-07-29), which would
// otherwise hide the publication from our own subsequent polls. Same
// chain, same endpoint -- the gateway ignores the query.
export async function awaitBeaconRound(round, fetchImpl, sleepImpl) {
  const doFetch = fetchImpl || fetch;
  const doSleep = sleepImpl || sleepMs;
  const start = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      // Each attempt gets ~6s: a blackholed fetch must not hang the
      // press forever. (Real sleepMs here, not doSleep -- tests inject a
      // zero sleep for the cadence but must not shorten the backstop.)
      const res = await Promise.race([
        doFetch(BEACON_URL + round + "?p=" + round + "-" + attempt++),
        sleepMs(6000).then(() => null),
      ]);
      if (res && res.ok) {
        const j = await res.json();
        if (j && j.randomness) return String(j.randomness);
      }
    } catch (e) {
      /* beacon hiccup: keep polling until the cap */
    }
    if (Date.now() - start > beaconTiming.capMs) return null;
    await doSleep(beaconTiming.intervalMs);
  }
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
 * reasoning models: max_tokens must be generous, because smaller caps get
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
  "Given a chooser name, respond with a raw JSON array of EVERY distinct item in the category, up to 200;",
  "if the category is smaller, list all of them.",
  "Items are nouns or short phrases, at most a few words each.",
  "No numbering, no commentary, no duplicates, no markdown fence. JSON array only.",
].join("\n");

// Lists are written once at creation and never change, so a pick stays
// verifiable forever. 200 caps completeness where the category is huge
// (models pad and repeat on very long lists, and creation latency grows);
// sanitizeItems is the single enforcement point.
const MAX_LIST_ITEMS = 200;

function sanitizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    if (out.length >= MAX_LIST_ITEMS) break;
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
    // 200 items at up to 48 chars each is ~2-3k tokens of JSON; the rest
    // of the budget is headroom for this reasoning model's chain of
    // thought. Worst-case truncation still fails safe: JSON.parse throws,
    // the create 502s, and the day's rate slot is never consumed.
    max_tokens: 16384,
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
 * KV records: c:<slug> -> {slug, name, kind:"user", items, created}
 * The list is immutable: written once at creation, never regenerated.
 * (Records from before lists became static (July 2026) also carry a
 * vestigial listDay field, which is no longer read or written anywhere.)
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
  L.push("  BUILT-IN (richer in a browser: a swatch, a drawn polygon)");
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
  if (c.type === "meta") {
    // The one built-in that can reach the server. Saying "the pick happens
    // in your browser" here would be a half-truth: landing on a visitor-made
    // chooser is a real press against that chooser's counter.
    L.push("  built-in. in a browser the chooser is picked locally; landing");
    L.push("  on a visitor-made chooser runs that pick on the server and");
    L.push("  counts as a press for it. pressing it here delegates the same");
    L.push("  way, over the whole shelf.");
    L.push("  " + c.blurb);
    L.push("  press it:  curl -X POST " + origin + "/api/pick/" + c.slug);
  } else if (c.kind === "builtin") {
    L.push("  built-in; no press counter. a browser renders it richer than");
    L.push("  a terminal can -- color is a swatch, shape a drawn polygon.");
    L.push("  " + c.blurb);
    L.push("  press it:  curl -X POST " + origin + "/api/pick/" + c.slug);
  } else {
    L.push("  " + c.items.length + " items on the list, fixed at creation; it never changes.");
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

/* ------------------------------------------------------------------ *
 * Hearn. maker's mark. Fraunces SemiBold converted to outlines, so the
 * brand letterforms need no webfont and no network request -- the same
 * "convert text to outlines for production" note the source asset
 * carries. viewBox is tight to the glyphs: its bottom edge is the
 * baseline, so vertical-align:baseline seats it against neighbouring
 * text. "Hearn" takes currentColor; the period keeps brand oxide.
 * ------------------------------------------------------------------ */
const HEARN_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="18.9 24.8 178.6 39.9" role="img" aria-label="Hearn."><path fill="currentColor" d="M26.7 44H50.9V46.9H26.7ZM31.7 59.3Q31.7 59.9 32.1 60.3Q32.5 60.7 33.1 60.9L34.7 61.3Q35.9 61.6 35.9 62.7Q35.9 63.3 35.5 63.6Q35.1 64 34.2 64H20.6Q19.7 64 19.3 63.6Q18.9 63.3 18.9 62.7Q18.9 61.6 20.1 61.3L21.7 60.9Q22.4 60.7 22.7 60.3Q23.1 59.9 23.1 59.3V29.5Q23.1 28.9 22.7 28.5Q22.4 28.1 21.7 27.9L20.1 27.5Q18.9 27.2 18.9 26.1Q18.9 25.5 19.3 25.1Q19.7 24.8 20.6 24.8H34.2Q35.1 24.8 35.5 25.1Q35.9 25.5 35.9 26.1Q35.9 27.2 34.7 27.5L33.1 27.9Q32.5 28.1 32.1 28.5Q31.7 28.9 31.7 29.5ZM56.6 59.3Q56.6 59.9 57 60.3Q57.4 60.7 58 60.9L59.6 61.3Q60.8 61.6 60.8 62.7Q60.8 63.3 60.4 63.6Q60 64 59.1 64H45.5Q44.6 64 44.2 63.6Q43.8 63.3 43.8 62.7Q43.8 61.6 45 61.3L46.5 60.9Q47.2 60.7 47.6 60.3Q47.9 59.9 47.9 59.3V29.5Q47.9 28.9 47.6 28.5Q47.2 28.1 46.5 27.9L45 27.5Q43.8 27.2 43.8 26.1Q43.8 25.5 44.2 25.1Q44.6 24.8 45.5 24.8H59.1Q60 24.8 60.4 25.1Q60.8 25.5 60.8 26.1Q60.8 27.2 59.6 27.5L58 27.9Q57.4 28.1 57 28.5Q56.6 28.9 56.6 29.5ZM91.1 47.5Q91.1 48.9 90.3 49.7Q89.4 50.5 87.8 50.5H70.3V48.4H81.8Q83.2 48.4 83.2 47.1Q83.2 43.4 81.9 41.5Q80.5 39.6 78.2 39.6Q76.5 39.6 75.2 40.6Q73.8 41.7 73.1 43.7Q72.3 45.7 72.3 48.5Q72.3 53.9 74.8 56.6Q77.4 59.3 81.6 59.3Q84.1 59.3 85.9 58.3Q87.8 57.3 88.8 55.5Q89.3 55 89.6 54.8Q89.9 54.6 90.2 54.6Q90.7 54.6 90.9 55Q91.1 55.4 91.1 55.9Q91 58.3 89.4 60.3Q87.8 62.3 85.2 63.5Q82.5 64.7 79.1 64.7Q75 64.7 71.9 63Q68.7 61.4 67 58.4Q65.2 55.3 65.2 51.3Q65.2 47.1 66.9 43.8Q68.6 40.5 71.7 38.7Q74.9 36.8 79.3 36.8Q83 36.8 85.7 38.2Q88.3 39.6 89.7 42Q91.1 44.3 91.1 47.5ZM111.7 60.4V59.9L111.2 59.7V43Q111.2 41.1 110.2 40Q109.2 38.9 107.4 38.9Q105.7 38.9 104.9 39.6Q104 40.3 104 41.3V43.8Q104 45.5 102.8 46.4Q101.7 47.3 99.7 47.3Q97.9 47.3 97 46.5Q96.1 45.7 96.1 44.2Q96.1 42.5 97.6 40.8Q99.1 39.1 101.9 38Q104.7 36.9 108.9 36.9Q114 36.9 116.5 39Q119 41 119 44.6V59.2Q119 59.9 119.3 60.3Q119.7 60.7 120.3 60.7Q120.9 60.7 121.2 60.4Q121.5 60.1 121.7 59.8Q121.8 59.6 122 59.5Q122.2 59.4 122.4 59.4Q122.8 59.4 122.9 59.6Q123.1 59.9 123.1 60.3Q123.1 61.3 122.5 62.3Q121.8 63.3 120.5 64Q119.2 64.7 117.2 64.7Q114.7 64.7 113.2 63.6Q111.7 62.4 111.7 60.4ZM95 58.1Q95 54.6 98.1 52.5Q101.2 50.3 106.8 50.3Q108.6 50.3 110.1 50.6Q111.6 51 112.6 51.5L112 53.3Q111.1 52.8 110.1 52.6Q109.1 52.3 107.9 52.3Q105.6 52.3 104.3 53.5Q103 54.7 103 56.8Q103 58.9 104.1 60Q105.2 61.1 107 61.1Q108.5 61.1 109.9 60.5Q111.3 59.8 112.2 58.5L112.8 60.1Q111.3 62.3 108.7 63.5Q106.1 64.7 103.2 64.7Q99.5 64.7 97.2 62.9Q95 61.1 95 58.1ZM135.7 49.2Q135.7 45.1 136.8 42.4Q138 39.6 139.8 38.2Q141.7 36.8 143.9 36.8Q146.5 36.8 148 38.4Q149.4 39.9 149.4 42.7Q149.4 45.2 148.4 46.4Q147.4 47.7 145.7 47.7Q144 47.7 143.2 46.8Q142.3 45.9 142.3 44.3V43.3Q142.3 42.4 141.9 42Q141.5 41.5 140.6 41.5Q139.6 41.5 138.7 42.3Q137.8 43.1 137.2 44.8Q136.6 46.4 136.6 49ZM136.2 38.8 136.6 45.1V59.5Q136.6 60.3 137 60.7Q137.3 61.1 138.1 61.2L140.5 61.6Q141.2 61.7 141.5 62Q141.8 62.3 141.8 62.8Q141.8 63.4 141.4 63.7Q141 64 140.2 64H127.2Q126.4 64 126 63.7Q125.7 63.4 125.7 62.9Q125.7 62.4 125.9 62.1Q126.2 61.8 126.7 61.6L127.8 61.4Q128.3 61.2 128.5 60.8Q128.8 60.4 128.8 59.5V43.5Q128.8 42.8 128.6 42.5Q128.3 42.2 127.9 42.1L126.4 42Q125.9 41.9 125.7 41.6Q125.4 41.4 125.4 41Q125.4 40.5 125.7 40.2Q126 39.9 126.7 39.7L131.8 37.8Q133.2 37.3 133.8 37.1Q134.5 37 134.8 37Q135.5 37 135.8 37.4Q136.1 37.8 136.2 38.8ZM162.9 38.7V59.5Q162.9 60.4 163.2 60.8Q163.4 61.2 163.9 61.4L164.9 61.6Q165.8 62 165.8 62.8Q165.8 64 164.3 64H153.5Q152.7 64 152.3 63.7Q152 63.4 152 62.9Q152 62.4 152.2 62.1Q152.4 61.8 153 61.6L154.1 61.4Q154.6 61.2 154.8 60.8Q155.1 60.4 155.1 59.5V43.5Q155.1 42.7 154.9 42.4Q154.6 42.1 154.2 42L152.7 41.9Q152.2 41.8 152 41.6Q151.7 41.3 151.7 40.9Q151.7 40.5 152 40.2Q152.3 39.9 153 39.6L158.2 37.7Q159.3 37.3 159.9 37.1Q160.6 37 161.2 37Q162 37 162.5 37.5Q162.9 38 162.9 38.7ZM162.1 45 160.8 43.7 161.9 42.7Q165.4 39.5 167.9 38.2Q170.5 36.8 172.7 36.8Q176.2 36.8 178.1 39.2Q180 41.5 180.4 45.3L182 59.4Q182.1 60.4 182.3 60.8Q182.5 61.2 183 61.4L184 61.6Q184.5 61.8 184.8 62.1Q185.1 62.4 185.1 62.9Q185.1 63.4 184.7 63.7Q184.3 64 183.5 64H172.6Q171.1 64 171.1 62.8Q171.1 62 171.9 61.6L173 61.4Q173.5 61.2 173.8 60.8Q174.1 60.3 174 59.4L172.5 46.4Q172.3 44 171.3 42.8Q170.3 41.5 168.4 41.5Q167.3 41.5 166 42.2Q164.7 42.8 163.2 44Z"/><path fill="#B4502E" d="M192.6 64.6Q191.2 64.6 190.1 63.9Q188.9 63.2 188.3 62.1Q187.6 60.9 187.6 59.5Q187.6 58.1 188.3 57Q188.9 55.9 190.1 55.2Q191.2 54.5 192.6 54.5Q194 54.5 195.1 55.2Q196.2 55.9 196.9 57Q197.5 58.1 197.5 59.5Q197.5 60.9 196.9 62.1Q196.2 63.2 195.1 63.9Q194 64.6 192.6 64.6Z"/></svg>';

/* ------------------------------------------------------------------ *
 * Social preview card, 1280x640. Inlined as base64 because this worker
 * has no build step and no static-asset pipeline -- 15KB of flat dark
 * PNG against a 60KB worker. Decoded once per isolate at module scope,
 * not per request. Source lives at assets/social.png; regenerate with
 *   base64 -i assets/social.png
 * Scrapers need a real URL, so it is served at /social.png rather than
 * inlined as a data URI the way FAVICON is.
 * ------------------------------------------------------------------ */
const SOCIAL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAABQAAAAKACAIAAABMkUL2AAAQAElEQVR4nOzdd5Rc2Z0f9luhc0A30D3IwCBPTpxEzlAcDme5TLtciqS4S0qUdhV8LEv28V8+9h/ysaRj2daxLZ+jc6xgaVfaXZGbyV3mNCSH5OQ8AwziIGeg0TlUd5Vvo4AmBrEBVHVX9f18WGf4uur166pXr1H9fb/77i/f1tEVAAAAYKHLBgAAAEiAAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJCEfqB+ZTCafb4gLhcJEqGfxVcTXMlWM/5sKAAAAc0IArif3P/TYHfe9Ly78xVf+4/DgYKhbn/vyP8jn8yeOHv7uX/5JAAAAmBMCcD0pZc4txPJpqGfZrLH3AADAXJNDAAAASIIADAAAQBIEYAAAAJLgGuDLWLHm1mUr1oRQev2lZ3O57G133b9yzbrW9o6x0ZFTx4+99doLQwMD5TU7F3WvXrdx6bIVrZ2dTU3NQwP9fadOnDh2dM+OrRddprtu423dPbcUpwqvvfjsLctWrrp1w/JVq/P5hlMnjm1745X430ufRvyW+Ex6ly6fGBs7cmj/znfevMpz7lrcs27TbUt6l3Yu6hoeGowb3L9n1/Gjh2ZWKJVKDzz6wUwme2jfnrUbNq1YfevQ4MD2t147sHf3nfc9FO/J5xoO7tvzyvPPhJuTb2jYdNtd3T293Ut64z45+2SObn/7jcH+M5euHJ/Vuo1bVqxae8uKVRMT4yePH33jxWfHxkYvXXPFmnWr1q7r6Vna1NLSf6bv9Imju7a/PfNG3MzKy1as3nTH3Z2dXc1tbYXxiZGRoRNH407adeb0yUtXbu/sXL/p9rif4w6P78upk8f27t559ND+S9eMB8D9jzwe///4kUMH9+1eunzl7Xc/sGjxkmw2OzTYv3vH1nd3vBNf/szKG7bcufrW9e0dXY3NTfFIGx0aOnxw3753d40ODwUAAKASMm0dXYH3eviDT26+/e648LWv/u5Tn/xse0fnhY/G3Pi1r/xuXNh8x70PP/7EZbcQk+ePv/tXE+PjM/c8+YnPrFgVQ3X42Q+/8/hHPnbR+j/+zl8d3L9n5ssYhz7w4V+NyfDCdQoTE8cOH1x16/ryE7swzl3pmWx97eVXXvjZzDa/9Pf/20vXObT/3RjvZ758563XXvrFT8KNWrZyzQef+kRTU9OlD/30+9/c/+6u8vIX/94/jjnwxNHDMZ1uvO3OC1eLL/Mbf/YHF85xHdd89K99ZP3mOy7aYLFY/PmPvrNvz84L77yulaOPfOIzy8++L5f6g3/3/1x0z8bb7nr48Q9fOoPX9rdfjzttJs2WNTQ0fuG3/+u4sGfntiMHDzz24Y9e9F0zO6S5pfWTn/tSS0vrpc/h9Inj3/qLrwQAAKASco1NzYH3Wrl2XSzxxYUlPUu7l/TEhYEzZ2JNNQacpubmWKiMKTHeecuyFStWr40L8aGjB/cf2Le7/8zpto7OWNdta+9cu2FzebWydZtu7+hcFBfWrN8Yw9ihfe/GkByTT0Nj4/Smlq/c+sYrM0XjBz/w12IRNZyNbTGzHT18oKW1La7c2dVdXiFueSZdr12/6QNP/Ep5+VhMWnt3T4yPxdJ0/LJ32Yqzd07XgePG73nfI+XVYqyanJpsOvvWxzXjT4m130Vdi+OX8b9vv/ZSuCGr1qx/8hOfzuenhxXE0wQH9+4+cnB/DLQtbe0xNB4+uD+Wx8tr3v3AI/H5tLV3LO65ZXx8fP+7O/tOn1zUvSTemcvl4k6Or2Jms4988COxOlreGwf27TlycF+sY7e2tceV42uPP2Lkghrpda0cS9+bbp/ez5OTk3t2bNu3e/ppFAqF8jv1xsvPX/jq7rz3wYce+1D5PYrb2b9nZyzkdizqji+t55ZluXz+ojpwfCF33f9QXIixOL6b8RvjrojF8JGhocbGpvhofGfjARNX+PDHf72re0lciM9t57a34nsxOHAmEzItbW2xFLxz25sBAACoBEOgryYGyDNnTj/9ra8PD50rt8agsnbj5vLyYH9/zIrb3nptbGR45lte/PmPP/rrn+9dujzWjWM59NLBsTFrffvPv1JOPrlc/pOf/VJnV1dMaPFnnTx2JN7Z2NQUK7rhbIT79l98pe/U9EDcl5975qlPfmbp8lUXba08sLm8/NxPf7jrnbfKy/FHx/Xjwl33P7z19VcmJwsz33Li2JHvfv2P4zd+/m//V83NLfGeb/35V86cPrnlznsfeuyJGMjbOjpuoMlwJpZen3iqvPzmK8+//tJzMw/FV/Tw408WpyYv/a6+kye+91d/WihMxOXXX3zuM1/87biwftPtv3j6e+UVYvIvl4jj3vjO1/7o9Mnj5ftjmL/nfY/Ghfjy48u5gZXLP6i88OPvfP3o4YMz98dTA+vfW5eOO+reh95f3vIPvvHnM2PLX3n+55/63Jfio3fe+76d29647CjrxUt6w/Q7+NNtb7x6bl9lMrffff/w0PROzjc0lN/WuOVv/OnvT4xPzHxjPDfRs2xZAAAAKsQkWFcznaP+4qsz6Tc603fq9RefLS8f3L/n1Rd+fmH6DWcT6Wsv/KK8vHTFyku3GeuK5fQbTU1Nbn39XLm1o/PcWPSNW+4qD7Ld/vbr5fQ7vdli8dmffP/SrS1fuTrWUcPZJDmTfqMYvPfsfCecHRK8Yct7xgOfODods2MGm9l4uTA7ExebmlrC9dtyx73lOB2roxem3ygWq3/2w2+/u2v7pd/1i598v5x+o7ifZ4YoN58fD3zbXfeVF7a98crMMwxnd+Po6EhciOcayuXu6105am1rC2ff5QvTbzQ+Prbt9ZcvvOe+hz9QflOe/+kPL7yyOr77b736Qnl50213hyt44+XnZtJvOHuQbD1/4Xdzy7m9fer40QvTbzTQ37dn+7YAAABUiAB8NW+/9uJkoXDN1aZH83Z0xDreitW3xltbZ0f5/nIgvMj+d3dc+GX/mb7yQiwClxe6liwpL+ze8Z7wE6uLZ84n5xmLus+tvPOC9Fu2a9u5exYtXnLh/RMT58ZOl5NnrEiXh/UWJs6lr8bGy1zBe009S8/VKl978Rez/Jbx8fGZQdFl/X2nygu/3BuLr/ICz40NXtS9+AZWjobOntqIyfbOex8MV9VzdjB5NDo2smzF6nO3lWvibWTo3JjqJbdcvlobA3Yswl9pyzPf3rtsxS3LVgYAAKBqDIG+mhPHjl59hZ6ly+976APLVqy67KPZbO7SOy8aXTwxPlZeaGg49150dCwqLwwNXDxt8uCZvq6uxRfe07Ho3MoDl2TjWD+8aINlU+eHQ0+eC8Dnvzw/RLl8WfL1mrk++fR7M+1VjAxfPNB65sLmhoZzz6H9/CRtQwP9F6080H/unvZFXTewcvTujne6H308Ltz/yGN3v++R40cOHZu+HYhF8osm8e48X59/8mOfDldwYbR+z48eOHPhEPSLxHh85NCBWMmPyx/99c+NjY0ePXTg+JHDhw++e6VpqwEAgBsjAF/NpTnqQuu33P6BD/1yat+YZMrF1UwmW54GOZPNXPpdF80VPGMmcbW2nysgX1p8Hn3vcOuorb3z/EMjFz00Njpy0Tozz/P8UunC51Mq/rIlT7h+5Zgd68mlme1fy+TExJUfPPdkyqOU42YvXWNmb7SdLxdf18rR1jdebmhqjOXfWATO5/MrVq8tz2oWS9PPfP8bM+OiGxqbZmZ+vmyLpnM/Yujy/YqGLtf/6UI//+G3H3zsiVs3TF9b3tzcEhfOLj/Rd/LEj7/3jQtH4AMAADdDAL6amdHCl8o3NMyk39dfem7H26+Nn69etrZ1/PUv/U64iR/aFjqu9EMvuqdw/hle+lA+f+6eycJVcmbFFAoTsXR8aYug6m125gXO1LSva+Wy1198duvrr2y+455Yxl+6YlX5e+P5i6c+9dm//KP/NHA2u87swJHhoT//w/8QrtNVjqKyGKp/9sNvv/bizzffcd+y5SsX995Svr+7p/djn/lC/ImzP6cAAABchQB8g1avXV9eePu1l9585T39cmaGJd+Y4YGB7sXTvZeaW1pnqrhlLa3tF608eH6U7NmHjl34ULkcOr3O4NXq2JUSs2Lr2XZHsYZ5lTLp9RoeGixvNibYiwYSz1wnPDO8+bpWnhFPIrz92ovxlsvn127YdP/Dj5db8t529/0v/OzpcLZIPjo6Eu+sas+woYGBV577aTj7vm/YEsvSj8YXEn/oqjXrLmwKBQAA3DCTYN2g1vPjisuTKl9o5ep14SYMDZ1LaMtWrL7w/kwm07t0+cUrD54LwCtWr7nooeWr1p5bZ2AuAvCZ0+fmlF733kmnb9Lg+Quhl6+6+AXOvOSh8wn/ula+1NTk5J7t2575/rfKX154TW/5Eut8Pt919txEVcWzHjGNb3vj3DTUnV2LAwAAUAkC8A0aGTl3weeaDZsuvL+lte22u+8LN2H/nnPlvtvvuf/CC4Zv3XRbDGAXrXz08IHywsbb7mq4YPbm6U6z9zxQXj64791QfXvOz1l97/sevXT667aOjo4LZp+avUP79pYX7rzvwQv3Rktb+6qzRfhisVjuJ3S9K4ezg9Uv/Ynl9rxhOg9Pzdw5M6X2w48/cdmruGMwnpm467pkztbML71/8Hyl+rL9kwEAgBsgAN+g08fP5ahbN2yOibe5pTWXz69cu+7X/8aXb/I62ONHD/WdraYu6V36wac+0drWHre8buOWx5746KUrjw4P7d6+NZzt5fPJz35xcc8tMfp2Lur+6K99rr1jukYd896JY4dD9Z0+eXzPzukMHFP6b3zxd9au39R0dsBwfDJ33vfQZ37rd26sx8/e3dvLibTnlmVP/OqvtXd2xhcYNxVfbHmFC1tVXdfK0W/81t/51N/4Wxu33BnXDNOX/jbHd/Mjn/hM+dGD+/bMrPnuru2nT0w3Fp7e2ue+VVIY6AAAEABJREFU1Lt0RT7fcHZXd63fcvsnPvvFT33uS13vbTc1S92Lez735X/w5Md/Ix485e7H8clsvuPeBx974tzT2D8X5y8AACAFrgG+Qf1nTsdQFHNpTJ4Pvv9D8Tbz0JGD+y8dgntdXnjmR7/ya5+LWz4/IfDVvPbiL6azU3NLTLyf+Ou/deFDk5OTzz/zozBXXv7FT2IhdPGS3piBY3QPlRBD5rM/+cGTH/903Burb90Qbxc+OjQ48PbrL9/YymVdXYsf/dBTl/7cgTNnymcWZvzsR99+6lOfjecj4gv81U9/PlTUzATUF9n1ztuD15pEGgAAmCUV4Mv45aS7V2hZVPbcT3+wY+sbF95TLBZjYvnp9795/uvShY+FC1sQzfysUnHme2fuPHHsyLf+7L+MvncGrK1vvPr2ay+dX/mXWx4dGf7aV3734N49F2051n6//tXfi4XZ8z+odNFC8b2v7pf3F6/2qq9ifHw8Pu1XnvvZpS8zPr1jRw7MfFleoVi6eLWZH33hUzt6aP83/uT3YyK9aOUYUP/yj/7TRc2irmvlPTu2XXa+ru1vv/6dr3916r1jjwf6z8T9/M5br1766mLZeetrL/e/txXzL0dKX3V/jowMHz6w79JtFiYmXn72p/EYCwAAQIVk2jpu5MpMZjQ1NXctXtLa1tF36sSZvlOholra2ntvWTY+NhojcfFavXCyuVz34p7OrsVDA/3xyVw0DfIca25ti08m1qWHBvv7z5yaGK9AK6bGpsbuxb2xBtvXd7r/9MnSVU9PzH7l+N51dC5qbWubmpoaHOiPFder77q4qfaORfHVNTQ2DA1G/WOX9Ge+AYu6Fre2dzS3to6PjQ0P9Mf38OovEAAAuF4CMAAAAEkwBBoAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCfnAWX/3n341VN9/+Ce/GQAAAJgPKsAAAAAkIdPW0RUAAABgoVMBBgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQhHyAepDNZvMNTbmGxny+IdfQkM3mAgBQBcXi1FShMDlZmCpMTBbGi8ViAFgoMm0dXQFqW1Nre0NjcyaTKU5NTk1Nxf+WSqUAAFRB/MDN5vK5XC7+N37gFsZHx0eHA8CCIABT4zId3T3x3PPE2EgAAOZcU3NrJpsd7DsRAOqfa4CpYZlsV+/ywviY9AsA82V8bKQwMdbduyJ+LgeAOucfMmpWpqtn2fBA39TUZAAA5s/U5OTQQF93z7IAUOcEYGpU5+LeseHBAADUhtGRwY7u3gBQzwRgalFTa/vUNLVfAKgVsQ5cKhabWtoCQN0SgKk52Wy2obHZdb8AUGvGx0YamloyWX9AAvXKv1/UnFxDYyYAALUok8nk840BoD4JwNScfENTsTgVAIDaU5yayjc2BYD6JABTc/INjVNTAjAA1KKpqcn4SR0A6pMATM3J5fNF018BQE2Kn9HxkzoA1Cf/flFzstlcqVQKAEDtiZ/R8ZM6ANQnFWAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEiCAAwAAEASBGAAAACSIAADAACQBAEYAACAJAjAAAAAJEEABgAAIAkCMAAAAEkQgAEAAEhCPgAAMFcymcxDH/3iqk33nzi468ShXccP7Dp9bF8olQIA1ScAAwDMkVy+8YnP/aOVG+6Oy+2Llqy785G4UBgfP3Vkz/GYhw/uPHFoz8TYcACgOgRg0rJxyx0bttzR1b048F79Z/r27Hxnx9Y3AwDV0dLe9eTf+O+WLL/1ovsbmpqW3Xp7vMXlUqk0cPpILAvHPHzy4K7+U0cCAJWTaevoClBLFi9dNXjmVKiCzbffff/D7w9c2esvv/DOW68FACpt8bK1Mf22dnRf13eNjQyeOLR7erB0zMNH3p0qTIQa0NG15PSxgwGgDqkAk5ANW24LXNXGLbcLwAAVt2L9XU987h/lG5rCdWpu7Vi96b54i8vFqam+4weOH9wZw/DxAztHBvsCANdJACYh7R2LAlfV0toWAKioLe/7yEMf/WI2e7OtN7K53JLlt8bb7Q/9Svzya//v/zRw2gBpgOujDRIJGR0xrcg1DA32BwAqJJPJPPyrX3rkY3/z5tPvpVZvuT8AcJ0EYBLy7q7tgas6tH9vAKAScvnGJ7/w39/24FOhOspTSQNwXQyBJiHb334jl8stX7XWLNCX6u8/c/Tgga1vvBoAuGlXmvC5gnpXbWxobC5MjAUAZk0AJiGTk5NvvPJivAUAqJobm/D5euVy+ZUb79m79YUAwKwZAg0AUDEr1t/1sS//j9VOv2WrNz8QALgeKsAAAJVRqQmfZylWgLPZXLE4FQCYHRVgAIDKuOfxX5uz9Bs1NrX0rt4YAJg1ARgAoDJOH9sf5taK9eaCBrgOAjAAQGXMfQBeoxswwPUQgAEAKqNvzgPwoiUrOhcvDwDMjgAMAFAZp48eCHNutSIwwKwJwAAAlTFw+uhkYTzMrZUbXAYMMFsCMABApZT6jh8Mc6t31caGxuYAwCwIwAAAFTP382DlcvmVG+8JAMyCAAwAUDF9R+c6AEerNz8QAJgFARgAoGLmvgIcxQpwNpsLAFyLAAwAUDF9xw/O/TxYjU0tvas3BgCuJR8gGc3Nres2benqXhxg/gz09+3e/s7Y2EgAFqKpyYmYgXtXbghza8X6u4/t2x4AuCoVYBKyYcvt0i/zrnNR98bb7gjAwjUvo6DX6AYMMAsqwCSkY9GiADWgvbMzAAvXvMyDtXfrCwGAa1EBJiHDg4MBasDoyHAAFq65rwC//szXXv/p1wMA1yIAk5D97+4a6O8LMK8G+s/s3bUjAAtX3/GDpVIxzBXpF2D2DIEmIf1n+uItAEA1TU1ODJw+umjJilB90i/AdVEBBgCosNNHD4Tqk34BrpcADABQYXNwGbD0C3ADDIEGAKiwvioHYOkX4MYIwAAAFVbVCrD0C3DDco1NzQFqSUt758TYaACAujVZGN/91rND/SdzuYbWzu5MpmIXndVC+m1qbh0dHggAdSjT1tEVoJYsXrpq8MypAAALQkNz65pN96/afP/y9Xc2Nt5U4aFGar8dXUtOHzsYAOqQAEzNEYABWJCy2fzStbet3nzfqk33tS9aEq5T7Yx8FoCB+iUAU3MEYAAWvMXLb1218b41m+9bvGztbNavqet+BWCgfgnA1BwBGIB0tLZ3rzpbE1526235fONl16m1Wa8EYKB+CcDUHAEYgATlGxpXbLxn9ab7V224p6m1feb+GpzzWQAG6pc2SAAA82+yMLF/20vxFjKZW1ZtKl8qvHfr8zoeAVSQCjA1RwUYAGqZCjBQv1SASUhDY9PS5Sva2jsCC9HI8NDRw4cKE+MBAAAup2Jt2aH2LV+xSvpdwFrb2pevXB0AAOAKBGBSUSqVmttaAwtac2tLfKMDAABcjgBMKjKZzPjoaGBBmxgfj290AACAyxGASciJY0dGRoYCC9To8PDxI4cCAABcgUmwSMjI8PDIu3sCAACQJBVgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEICpOcXiVCaTCQBA7Ymf0fGTOgDUJwGYmjM1Wcjm8gEAqD3xM3qqUAgA9UkApuZMFgq5XC4AALUnl8tPTgrAQL0SgKk5k4XxbFYABoBalM3lJifGA0B9EoCpOZOFiVIAAGpRqVQqTE4EgPokAFNzSsViYXy0qbk1AAC1JH46x8/oUCwGgPokAFOLxkeHs7lcLm8qLACoFbl8QyabjZ/RAaBuCcDUqMG+Ey2tHQEAqA0tbe2DZ04GgHqWa2xqDlCTxsaGF3X3Tk1Nlgy1AoD5E2u/bR1dfcePhmCaDqC+CcDUsFJpfHSopW1RLp+f0nEBAOZDU0tbPp/vP31M+gUWgEw8nxegtsWP3samlpDJFKeiyWKsCZd8BgNAVWQymWwun8vls7lcKZQKY6Ou+wUWDAGY+pDJZvP5pnxjU76hIRaENQoGgCopxvPNk5OThcLkxHhhctycz8BCIgADAACQBLNAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJAjAAAABJEIABAABIggAMAABAEgRgAAAAkiAAAwAAkAQBGAAAgCQIwAAAACRBAAYAACAJ+QAA9S+bzeYbmnINjfl8Q66hIZvNBRa0YnFqqlCYnCxMFSYmC+PFYjEAwLVk2jq6AgDUs6bW9obG5kwmU5yanJqaiv8tlUqBBS2+3dlcPpfLxf/Gt7swPjo+OhwA4KoEYADqWqajuydW/ybGRgIJa2puzWSzg30nAgBcWa6xqTkAQD3KZrt6lk+MjkwWxgNpm5oslErFjq6esbHhoP4PwBWYBAuAupTJZBu1ucMAABAASURBVLuWLBse6JuamgwwnYEnhwb6unuWZTKZAACXIwADUJc6unvGhgcDvNfo8GB7V08AgMsRgAGoP02t7VPT1H65WKwDl4rFppb2AACXEIABqDPZbLahsdmsV1zJ+NhIQ1NzJuuPHAAupg8wAHUm39DkIk+uLh4h8TgpjI8GqDe6mnPDNEifDQEYgDoT/y4sGvzMVcU/AvMNjQIwdefCruaFwsT42Iiu5szeTIP0fGt7Y6lNg/TLEoABqDPTwWZC3yOuZmpqsqGxKUA9OdfVXGLhhsXTJfHMSbyVv2xqbm1sbtUg/SIujwGgzuTyeRVgri4eIfE4CVAvMtmu3uWF8TGzG1BB42MjhYmx7t4V8QALnGdfAFBnstmcMYFcXTxCXDlJ/ch09ehqTlXMNEgPnCcAAwDAvOlc3KurOVU1OjLY0d0bOMvooMsz/x5XZ5I9AODm6WrOHIh14Hy+2NTS5grzIABflvn3uCaT7AEAN6nc1dyfEMyBmGhiAJ4YHy0lX7YRgC9i/j1mxSR7AMBNyjU06mnOnJlukJ5vLEyMhbS5BvgC5t/jRplkDwC4XvmGpmJxKsCcmG6Qrj+cAHwB8+9xU0yyBwBcl3xD49SUAMwciTEnHnIheQLwOebfoyJMsgcAzJKu5swlDdLLBOBp5t+jUmIduFScnmQvAABcla7mzCUN0ssE4HPz77nul0oZHxtpaGrJZP1yAQBAbfE3uvn3qLzyJHsBAACoJQKw+feoPJPsAQBADRKAzb9H5ZlkDwAAapB5wKbn3xsfHQ5QOWcn2TMPFkASstlsvqEp19CYzzfkGhrMMVOnisWpqUJhcrIwVZiYLIwXi8UALEQCsPn3qDyT7AEkoqm1vaGxOZPJxFOfhcLE+NiIPyrqVHwTs7l8LpfLt7Y3ltoK46MKJLAgCcAAADcg09HdE+uEYtLCEM9cxJMY8Vb+sqm5tbG5dbDvRAAWFtcAAwBcp2y2q3d5YXxMG8WFKhbzCxNj3b0rgr6GsLD4lQYAuA6ZTLZrybLhgb6pqcnAwjU1OTk00NfdsyyT0TETFg5DoAFIXXNLyz3ve2TZ8lUtra0hPaMjI0ePHHzj5efHRkcDs9DR3TM2PBhIw+jwYHtXj7HQsGCoAAOQuvsefP+6DZvTTL9RfOHx5cedEJiFptb2qWlqv6mIdeBSsdjU0h6ABUEABiB1y1etDsmzE2Yjm802NDa77jc142MjDU3NGRcDw4JgCDTUN/0nmV86Z5KU+O+ty0HTFN/3+O4Xxl0mAHVPAIY6pv8k825hdM48cvDA2vUbQ9riTghcSzzbWDT4OUnxXF++oVEAhgVAAIY6pf8kNWFhdM587aVni6WiSbAC1zIdgSbGA+mZmppsaGwKQP0TgKEOZbJdPcvGhgfNwkKtGR8byeXz3b0r+k4eDaW6GQ49Njr6ws9+HOBa4uHttGOaYuU/l28LQP1zNT/UnUxMv/pPUrNmOmcGWHCy2ZwrTdIU33ezbMDCoAIMdaZzca/+k9S+0ZHBju5enTMB5lLiXc1naG/OVagAQz3Rf5J6cb5zphGDAHMn8a7mM7Q35yoEYKgb+k9SX852zmzRORNgzmjofSF7g8vydwnUjVxDo+6T1Jfpzpn5xgAAUBsEYKgb+YamYnEqQP2Y7pypcQjAXNHQ+0L2BpdlEqwKW/BzD5hUYB7pP0nd0TkTYC4l3tV8hvbmXIUAXGH3Pfj+tes3hoWrPKlANpN97pkfBeaW/pPUHZ0zAeaSruZwTQJwhSVytb1JBeaF/pPUHZ0zAYCa4hpgAAAAkiAAV1giV9ubVAAAAKg7hkBX2IKfe8CkAgAAQJ0SgCvM3AMAAAC1yRBoAAAAkqACDEDqmlta1qzb2NW1ODBXBvrP7N2zQ0t5AOaYCjAAqVu3YYv0O8c6F3Wt33hbAIC5JQADkLhMe0dnYM61tXfEnR8AYA4ZAg1A4kojw0NnwxhzanR0JO78kLDmlpZ73vfIAuscMdMtwvh2oDapAAOQugP79gz0nwnMocGBgf3v7gppu+/B96/bsHmB9U2MLye+qPjSAkBNUgEGIHUx/QrAzL3lq1aHBWoBvzSg3qkAAwAAkAQBGABgHhw5eCAsUAv4pQH1zhBoAIB58NpLzxZLxYU6CVZgPuhqXl90RJ8XAjAAwDyIf/W+8LMfB6icdRu2dHQuCtSJckf0rW++GphDAjCka0F24Jhf+n8AMI90Na87mvDNPdcAQ7oWZAeO+aX/BwDzaGR4KFBXznZEZ04JwJAubSqqxI4FYF7oal5fdESfF4ZAV5i5B2qBGQUAgATpag7XpAJcYes2bJF+5115RoHAtWhTUSV2LABAbVIBrqyMuQdqxNkZBTIhlAJXtiA7cMwv/T8AAGqZAFxZpZHhIZO51YKzMwpIv9egAwcAAEkRgCvswL49K1at7VzUFZg/gwMDhw68GwBmp6GhYckty1rb2gOzMDoyfPLYkUKhEACg3gjAFWbuAYC607t0RbMLAWatpbXtlmUrDx3YGwCg3gjAAKSuuaUlcD2ampsDANQhs0ADkLqxsbHA9ZiYGA8AUIcEYABS13fy+NjwcGB2xkZGTh0/FgCgDhkCDUDqRkdHRg/tDwDAQqcCDAAAQBJUgAEA5kFzS8uadRu7uhYHbs5A/5m9e3aMjY4GgGsRgAEA5sG6DVs6OhcFblrnoq71G2/b+uarIXm6mlePFugLhiHQAABzL9Pe0RmokLb2jrhLQ/J6l66Qfquk3AI9UP8EYACAuVcaGR4KVMjo6EjcpSFtpVKpSVfzampsbo47OVDnBGAAgHlwYN+egf4zgZs2ODCw/91dIXmZTGZcV/NqKkyMx50cqHOuAQYAmAcx/QrAVFbfyePdi3ua29oClTY2MtJ36kSg/gnAFWbugZthdgEAgBumqzlckwBcYb1LVzS3tgZuSHl2gUMH9gbmRFNz89p1Gzu7ugMLV6wv7duz06A4AIDgGuCKazb3wM2JkSwwV27dsFn6XfA6F3Wt27glAAAgAFfcmDLLzZmYGA/MFR04EnG2OwgAAAJwpfWdPD42PBy4IWMjI6eOHwvMFR04EjE23R0EAADXAFeauQeoIwf3vbt89ZrOzq7AwjU40H/4wL4AAIAADCmL0Wjw7TcDAACkwRBoAAAAkiAAAwAAkAQBGAAAgCQIwAAAACTBJFgAAPOgoaFhyS3LWtvaQ3pGR4ZPHjtSKBQCwNxSAQYAmAe9S1ekmX6jlta2W5atDABzTgUYAGAeNLe0hIQ1NTcHgDmnAgwAMA/GxsZCwiYmxgPAnBOAAQDmQd/J42PDwyFJYyMjp44fCwBzzhBoAIB5MDo6MnpofwBgDqkAAwAAkAQVYEhXyh04LqIhBwBAClSAIV0pd+C4iIYcAAApUAGGdCXegeMiGnIAACx4KsCQrsQ7cFxEQw4AgAVPAIZ0pdyB4yIacgAApMAQaEiXDhwAACRFBRgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBLyAQA461NrOj68qv3uJc23tDQEquz4aOHNU2NPHxz6xv7BAABzQgAGgLC8Nf9PHlz6/mVtgbkSzzJ8ZFW8dXzy1s5/+tKxIyOTAQCqTAAGgPAvHl1+X09LYD7E8w7/6yPLf/vpAwGohIduy/3tjzctX5Jtb72pqx2HRopHThX/07fHX3xnavbf9diy1n9015JV7Y0djblwEwYnpg4OTfzrt079/OhIgMpxDTAAqfv1Wzul3/l1f29LfBcCcHOymdLf+UTjP/v7rZtW528y/UZxC3E7cWtf/lhT3PI118+G0j++a8m//uDK2xe33GT6jeIW4nbi1v7hnUvilgNUiAowAKn71dUdgfkW34W/3DsQgJtw1/r8bz3VHCoqk8n81lONb+6efHXnNerAD/S2/t07loRK//S/d8fil0+MPH98NFTU6s0PPPqJv91/8vCZE4firf/U4TPHD4+PmpJg4ROAAUjdlq6mwHzzLsDN+8JHqvJ7lM1mPvfhpld3XmMo8m/ftjhU46dnMl/esvj544dC5TS2tD3ysb/Z0tYZb8vW3jZz/+jwgEi84AnAAKSup8Wn4fzzLsDNW7+iWpc3zmbL1TuNVfEtP/SR32zt6L70fpE4BT5sqqJScw/cpBubugAAgHq0uLNaf3nOZsvVO41V2S3fsnrzhnsfn+XKIvHCIwBXWDZT+vLHm37zI02ZTCbMt+mpC1qz/+zv5/7L9yf+4LtjxdL8PyUAAJgv2WzuA5/6nXATLo3EP/jK/3l4z1uBOmEW6Aq7a8P03AO1kH5nlKcuuHejkx0AACTt3g99pnPx0lBRDz71mzX1xz9XJwBX2BeerMU5PMpTFwQAAEhV99I1dz768VBpXb0rN933oUCdUBWssOrNPXCTavaJAU2tHY9+7G8tWbH+2P7txw/sPLZv+8DpIwEAqJxYpH3sU7+TzVblT+L7PvSZd99+rjAxFqh5AnCFVW/ugZtUs08MErfmtgdj+m1u64zL7Xd/YMPdH4gLY8ODxw/uOBrz8P6dp4/uC6EUAICbcMejH1+8bG2ojvg5ftdjn3r16T8N1DwBGGB+lAu/a29/6NKHmts61mx5X7zF5fHxkZMHdh87EIvDO04efrc4NRkAgOvR0X1LLNKGarrj4Y/uePnp4YFTgdomAAPMgwsLv1fX1NS6cuPd8RaXJycnTh7aG5NwzMMnD+wqFAy1AoBr+8CnfieXq27wyeUbHnjy88987d8EapsADDCnrlL4vaZ8vnHZ2s3xFsKnSsXi6WP7j++PYXjH0X3vTIwNBwDgEhvueWzpmi2h+tbd+ci2F7538vCeQA0TgAHmzuwLv9eUyWaXLL813m5/5KOlUunMycOxMnx833RxeGSwLwAAIbS0dz34kd8Mc+Whj37x27/3zwM1TAAGmAs3U/i9pkwm0927Mt62PPDh+OU3/r//ORaHA1DbWlpa12++vbunJ9Se/tOndr2zdXR05LKP5vP5Rd1LmltaQm0YHxs7c/rk5KQpEriM+OHb1Noe5krvyg233vHw3q0vBGqVmYEBqi4Wfj/9D/55ldLvpTY98EQAat6mO+6qzfQbLVq8ZPOdd1/p0e4lPbWTfqOm5ubunt4Al9PZsyzMrQee/Hw2p8pYuwRggCqKhd8P/fV/+MRn/5uKDHuepfV3fSDf0BiAGpbJZDoXdYUa1tG5KD7Jyz7U2NQcakxjY1OAyzm8660wt9oX9dz+8EcDtUoABqiWOS78zmhobIoZOAA1rFQqDQ0Mhho2PDwcn+RlH5oYHw81pjBRCHA5h/a8Gebc3Y99Kp4BD9QkARigWh78yBfmsvB7oc1nLwYGatnePTv6+06HmjRwpu/dne9c8dH+vonxGmrDFp9M/xnNV7m8o3u9pquUAAAL4UlEQVS3TYyNhLnV2NRS7bbD3DDD0wGq5di+d9q7Hg/zYfGyNYuXrjEVFtSyM6dPxVuoQ+NjYyfGjgaoB8Xi1KHdb66785Ewtzbd96F3XvxB/8nDgRqjAgxQLScO7Q7zx1RYABAdno9R0Nls9sGn5q79ErMnAANUy8nDe8L8MRUWAITpAPz2lS5or6qBk0cCtUcABqiW08cOjI8MhXliKiwAiEaHzsz9Ken9219+8QdfDdQeARigekrHD+wI88dUWAAQ5nwU9IlDu5/52r+NfwYEao8ADFBFx+f1MuDyVFgBANJ2aNfcBeCB08d+9Ef/ampSa64aJQADVNHJw/MZgIOpsABScnqgGKpjNls+OToZquPmt3zy8J6Rwb5QfWMjgz/86v81PjpvF0BxTQIwQBWdOLh7fs8BmwoLIB17DlcrAM9my9vPjIfqqMiWj+x5O1TZZGEi1n4H+44HapgADFBFxanJ+W2GZCqs2ahe1YLZ8y7AzfvTp8eLxcpfdxq3+Uc/vHYE/c/bT4cqKJZKv/tOBbZ8qMqXAZdKxWe+9m/ntwEEsyEAA1TX/AbgYCqsWahe1YLZ8y7AzXt159SfPF35X6X/8v3xN3ZPXXO154+P/uGOymfgf7f11EsnRsNNO7T7zampKp5oe+kHf3RgxyuBmpcPVNTpgeLizlo8rVC9a0KAqzt5aJ5PBpenwjp9bH/gCv5095nHlrcF5lV8FwJw0/7jNyd+8FLhsx9qvH9zw9LFN/VH6bHTxVd3FP7sJxP7j822qvwvXzv5Z7v7/9aW7keWtq1oawg34fBw4fljw7+/vW/PYGWuJCqMjx7du23lhrtDFWx7/nvbXvheoB4IwBW253CNBuDqXRMCXN2xA9tLpWImM5//Mmx64Innv/2fA1fw9OHhnx8ZloHn0dOHBuO7EIBKiHn1//7jWAeen1EVMa/+Ly/V6EWwh/e8VY0ArOVvfTEEusL+9OlaHME1feXGjwwtg/kxMTrcd+xgmFemwrqmf/na8YkpJwrnx0ih+C9eOREAqqwazZC0/K07ucam5pC2lvbOibEKXFdQdvR0qb053H5rbZXW//B7499/0eQic6qpuXV0eCBUVGWPVeZS97I1PcvXhfmTy+WH+0+fOro3zLl6+V04M1H899tOHxyciH/CtDdk2xpygSo7Plp47tjIf9x6+n94/ujwZOXPPvh3mMpyRC0A46ND2195+vjBXcP9p4rFYlNrR/x8DDdh4PSx7//h/1GYGAt1ohqHcd0xBLry/s3Xx7/13ERFLr24STdw5QZQDScP7d4y3zNRbX7gwzte/XHgqr6xfzDeAgAL1NjwwIHtr8Tb9BeZTPfSNb0r1veu2tizYt2iJcuvb1Na/tYnAbgq5vfSC6DWHNv3TphXwwOnXv3JnwcAYEap1Hd0X7zteOXpMN04sKVn1YZbVm5YEiPxivVNre1X+VYtf+uXAAxQdUP9p777+//bA09+vnflhjC3ilNTW1/47uvPfH2qMBEAgCsoTIwe2fNWvJW/7Fy8vHfV+p4VG3pXru+6ZVU2+8tLY7T8rWsCMMBcOLZ/+7d/75+v3vzAfR/6TPctq8KcOH5w57Pf/L3+k4cDAHA9Bk4fibfdb/w8LufyjUuW39oTK8MrN/SsXL/1+e9q+Vu/BGCAuRM/Lw/sePXWOx++74O/0blkWaiaibGRV3/8Z++8/KNMAABuytTkxPEDO+ItUP8EYIA5Vtr79vP7tr64/u4P3PvBT7d39YRK2/P2cy99/ytjwwPSLwDAhQRggHlQKhV3v/Gzd996bstDT971/k+2tHWGShjsO/7sN3/36HzPuQUAUJsEYIB5UyxObnv+eztf/cltD/7KXe//WGNzW7hRk5MTb//iW2/+4pvFKU2/AQAuTwAGCPNrcmL8rV98Y8fLP7r9kV+9/ZGPNjY2h+t0ZO+2WPgdOnMiAABwZQIwQE2YGB95/ad/8c6LP7jng7+++f4P5fINs/mukaEzL37/K/u2vhAAALgWARighoyPDr74vT/c+tx37nn81zbc83g2l7vSmqVSaddrP33pB18tTIwFAABmQQAGqDnDA6ee/dbvvfnst+79a59ef8ejmWz2ohXOnDj07Dd/78ShXQEAgFkTgAFq1FDf8Z9//d+/9fNvPPDkF1Zvurd8Z2F8/PVnvrbthe+VSsUAAMD1EIABalr/ySNP//G/6lmx/oEnPz85Mfbct39/ZPB0AADg+gnAAHXg5OE93/uD/z0AAHATsgEAAAASIACHYnEqk8kEqJx4RMXjKlSaY5W643eB+eLYo7IcUSwAVTqM644AHKYmC9mcoeBUUjyipgqFUGmOVeqO3wXmi2OPynJEsQBU6TCuOwJwmCwUclfutAk3IJfLT05W/t8Xxyp1x+8C88WxR2U5olgAqnQY1x0BOP7TM57N+qeHSsrmcpMT46HSHKvUnSr9LkwVJrL+ZOSqpo+9wkSoNMdesqp0RPlkZy5V6UO57gjA8Z+eiVKASiqVSoXJanxMOlapM1X6XSgUxkt+Gbiq6WOvUPm/8xx7yarSEeWTnblUpQ/luiMAh1KxWBgfbWpuDVAJ8ViKR1QoFkOlOVapL34XmC9NLY49KskRxQJQvQ/luiMATxsfHc7mcrm8SQi4Wbl8QyabjUdUqA7HKvXC7wLzZfrYyzj2qBhHFAtAtT+U64sAfM5g34mW1o4AN6elrX3wzMlQTY5V6oLfBeaLY4/KckSxAMzBYVxHco1NzYGzxsaGF3X3Tk1NlowN4PrFU2ttHV19x4+GUPXLeRyr1LK5/l1Y7HeBcxx7VJZPdhaAuTyM60Um7pHAeZlMpr2rt1SaGh8dCTBrTS1t2UxmIJ5am6vZURyr1Ca/C8wXxx6V5YhiAZj7w7guCMCXEY+VxqaW+O9QcSqaLMazcQ4a3it+SmVz+Vwun83lSqFUGBudl8sqHKvMO78LzBfHHpXliGIBqJHDuMYJwJeXyWbz+aZ8Y1O+oSGXz2vRxkWK8XNpcnKyUJicGC9Mjs/jlHqOVeaX3wXmi2OPynJEsQDUzmFcywRgAAAAkmAWaAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAkQQAGAAAgCQIwAAAASRCAAQAASIIADAAAQBIEYAAAAJIgAAMAAJAEARgAAIAkCMAAAAAk4f8HAAD//+j8sYYAAAAGSURBVAMAQUqol+BybCYAAAAASUVORK5CYII=";
const SOCIAL_PNG = Uint8Array.from(atob(SOCIAL_PNG_B64), (c) => c.charCodeAt(0));
// Absolute and production-pinned on purpose: scrapers fetch this from their
// own machines, so a dev-host URL would be useless to them. Same reason
// canonical is hardcoded at both page() call sites.
const SOCIAL_URL = "https://random.oddspark.dev/social.png";

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0B0D10"/><circle cx="16" cy="16" r="3" fill="#C9A227"/><circle cx="16" cy="16" r="9" fill="none" stroke="#6E8FB8" stroke-width="1.5" opacity=".7"/><circle cx="16" cy="16" r="14" fill="none" stroke="#6E8FB8" stroke-width="1" opacity=".3"/></svg>'
  );

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Server mirror of the client clamped() numeric core (numberBounds in
// CLIENT_SCRIPT): parseFloat -> reject non-finite -> Math.round -> clamp
// to +/-1e12. The two acceptance sets must stay identical, or the client
// would silently rewrite a server-rendered bound on press; test.mjs locks
// the agreement by execution. A null raw (param absent) yields NaN, which
// is not finite, so the fallback covers both missing and invalid params.
function boundFromParam(raw, fallback) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1e12, Math.max(-1e12, Math.round(n)));
}

// One repeated ?d= value. A hyphen at index 0 is a sign; the first later
// hyphen separates an explicit range. Bounds deliberately remain unsorted
// here so a shared URL round-trips exactly; the client swaps only for rolls.
function dieFromParam(raw) {
  const value = String(raw);
  const separator = value.indexOf("-", 1);
  if (separator === -1) {
    const max = boundFromParam(value, null);
    return max === null ? null : { min: 1, max };
  }
  const min = boundFromParam(value.slice(0, separator), null);
  const max = boundFromParam(value.slice(separator + 1), null);
  return min === null || max === null ? null : { min, max };
}

function dieLabel(die) {
  if (die.min === 1 && die.max === 2) return "coin";
  if (die.min === 1 && die.max > die.min) return "d" + die.max;
  return die.min + "\u2013" + die.max;
}

function dieParamValue(die) {
  return die.min === 1 ? String(die.max) : String(die.min) + "-" + String(die.max);
}

function orderedDie(die) {
  return die.min <= die.max
    ? { min: die.min, max: die.max }
    : { min: die.max, max: die.min };
}

// Uniform local integer over every accepted dice span. Six random bytes are
// enough for the full +/-1e12 range and stay exactly representable by Number.
function localDieValue(die) {
  if (die.max <= die.min) return die.min;
  const span = die.max - die.min + 1;
  const sampleSize = 281474976710656; // 2^48
  const limit = Math.floor(sampleSize / span) * span;
  const bytes = new Uint8Array(6);
  let sample;
  do {
    crypto.getRandomValues(bytes);
    sample = 0;
    for (let i = 0; i < bytes.length; i++) sample = sample * 256 + bytes[i];
  } while (sample >= limit);
  return die.min + (sample % span);
}

function diceTrayUrl(origin, dice, roll) {
  const target = new URL("/dice/", origin);
  for (const die of dice) target.searchParams.append("d", dieParamValue(die));
  return target.toString() + (roll ? (target.search ? "&roll" : "?roll") : "");
}

function diceVerifyUrl(origin, dice, result, draw) {
  const target = new URL("/verify", origin);
  target.searchParams.set("slug", "dice");
  target.searchParams.set("round", String(result.round));
  target.searchParams.set("nonce", result.nonce);
  target.searchParams.set("item", String(result.item));
  target.searchParams.set("draw", String(draw));
  for (const die of dice) target.searchParams.append("d", dieParamValue(die));
  return target.toString();
}

function renderDiceText(dice, capped, origin, results) {
  const lines = ["dice tray"];
  if (!dice.length) {
    lines.push("(empty)");
    return lines.join("\n") + "\n";
  }
  for (let i = 0; i < dice.length; i++) {
    const result = results && results[i];
    lines.push("[" + i + "] " + dieLabel(dice[i]) + (result ? " = " + result.item : ""));
    if (result) {
      if (result.verified) {
        lines.push("    verified \u00b7 round " + result.round);
        lines.push("    " + diceVerifyUrl(origin, dice, result, i));
      } else {
        lines.push("    unverified");
      }
    }
  }
  if (capped) lines.push("tray holds 24 dice; extras were left out.");
  if (!results) lines.push("roll: curl '" + diceTrayUrl(origin, dice, true) + "'");
  return lines.join("\n") + "\n";
}

async function rollDiceText(dice, capped, origin) {
  const results = new Array(dice.length);
  const eligible = [];
  for (let i = 0; i < dice.length; i++) {
    const die = orderedDie(dice[i]);
    if (die.max - die.min + 1 > 4294967296) {
      results[i] = { item: localDieValue(die), verified: false };
    } else {
      eligible.push({ die, index: i });
    }
  }

  if (eligible.length) {
    let nonce;
    try {
      nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
      const round = await probeBeaconRound(BEACON_URL, fetch);
      if (!Number.isInteger(round) || round <= 0) throw new Error("beacon unavailable");
      const randomness = await awaitBeaconRound(round, fetch);
      if (!randomness) throw new Error("beacon unavailable");
      const values = await Promise.all(
        eligible.map((entry) =>
          deriveDie(randomness, nonce, entry.index, entry.die.min, entry.die.max)
        )
      );
      if (values.some((value, i) =>
        !Number.isInteger(value) ||
        value < eligible[i].die.min || value > eligible[i].die.max
      )) {
        throw new Error("dice derivation failed");
      }
      for (let i = 0; i < eligible.length; i++) {
        results[eligible[i].index] = {
          item: values[i],
          verified: true,
          round,
          nonce,
        };
      }
    } catch (e) {
      for (const entry of eligible) {
        results[entry.index] = { item: localDieValue(entry.die), verified: false };
      }
    }
  }

  return renderDiceText(dice, capped, origin, results);
}

function dieTileHtml(die) {
  const label = dieLabel(die);
  return (
    '<div class="die" data-min="' + esc(die.min) + '" data-max="' + esc(die.max) + '">' +
    '<div class="die-face unrolled">' + esc(label) + "</div>" +
    '<div class="die-label" aria-hidden="true">' + esc(label) + "</div>" +
    '<div class="proof"></div>' +
    '<button class="dice-reroll dice-roll-control" type="button" aria-label="Re-roll ' + esc(label) + '">Re-roll</button>' +
    "</div>"
  );
}

function diceCardHtml(dice, capped) {
  const presets = [
    [2, "coin"], [3, "d3"], [4, "d4"], [6, "d6"], [8, "d8"],
    [10, "d10"], [12, "d12"], [20, "d20"], [100, "d100"],
  ];
  return (
    '<article class="card dice-card" data-type="dice">' +
    '<a class="dice-back" href="/">&larr; back to the shelf</a>' +
    "<h2>dice tray</h2>" +
    '<div class="blurb">roll the whole tray from one beacon commit, or re-roll one die with its own proof.</div>' +
    '<div class="dice-presets" aria-label="Add a preset die">' +
    presets.map(([max, label]) =>
      '<button class="dice-preset" type="button" data-min="1" data-max="' + esc(max) + '">' + esc(label) + "</button>"
    ).join("") +
    "</div>" +
    '<div class="dice-custom">' +
    '<label>min <input type="number" class="dice-custom-min" value="1" step="1"></label>' +
    '<label>max <input type="number" class="dice-custom-max" value="6" step="1"></label>' +
    '<button class="dice-add" type="button">Add die</button>' +
    "</div>" +
    '<div class="dice-tray" aria-live="polite" aria-atomic="false">' + dice.map(dieTileHtml).join("") + "</div>" +
    '<div class="dice-cap" aria-live="polite">' +
    (capped ? "tray holds 24 dice; extras were left out." : "") +
    "</div>" +
    '<button class="strike dice-roll-all dice-roll-control" type="button"' +
    (dice.length ? "" : " disabled") + ">Roll all</button>" +
    '<div class="card-err" hidden></div>' +
    "</article>"
  );
}

function cardHtml(c, count, bounds) {
  const perm = ' <a class="perm" href="/c/' + esc(c.slug) + '" title="permalink">&para;</a>';
  let controls = "";
  if (c.type === "number") {
    // bounds arrives pre-sanitized from the /c/ route; cardHtml does no
    // parsing of its own, and a bounds arg reaching a non-number chooser
    // is simply unused.
    const numMin = bounds && bounds.min !== undefined ? bounds.min : 1;
    const numMax = bounds && bounds.max !== undefined ? bounds.max : 100;
    controls =
      '<div class="ctl">' +
      '<label>min <input type="number" class="num-min" value="' + esc(numMin) + '" step="1"></label>' +
      '<label>max <input type="number" class="num-max" value="' + esc(numMax) + '" step="1"></label>' +
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
    '<div class="blurb">' + esc(c.blurb || "a generated list, fixed forever") + "</div>" +
    controls +
    via +
    '<div class="result" aria-live="polite"><span class="hint">&mdash; press &mdash;</span></div>' +
    '<div class="proof" aria-live="polite"></div>' +
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
    '<div class="blurb">name it; a model writes the list once, another screens the name. the list never changes, so closed categories work best. one per day.</div>' +
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

  /* The meta chooser takes the whole first row. Full width is only worth
     having if the internals use it, so above 900px the card becomes its own
     two-column grid: pool controls and the press button on the left, the
     result on the right. Below that it falls back to the normal stacked
     card, which is what a narrow column wants anyway. */
  .card[data-type="meta"]{grid-column:1 / -1}
  .card[data-type="dice"]{grid-column:1 / -1}

  @media (min-width:900px){
    .card[data-type="meta"]{
      display:grid; align-items:start;
      grid-template-columns:minmax(240px, 22rem) 1fr;
      /* Row 6 is slack. A tall result (the 300px shape canvas) has to put its
         height somewhere; without a row that absorbs it, the extra lands on
         the rows the press button shares and strands it at the bottom of an
         empty column. */
      grid-template-rows:auto auto auto auto auto 1fr auto auto;
      column-gap:28px;
    }
    .card[data-type="meta"] > h2{grid-column:1 / -1; grid-row:1}
    .card[data-type="meta"] > .blurb{grid-column:1 / -1; grid-row:2}
    .card[data-type="meta"] > .ctl{grid-column:1; grid-row:3}
    .card[data-type="meta"] > .pool-more{grid-column:1; grid-row:4}
    .card[data-type="meta"] > button.press{grid-column:1; grid-row:5}
    .card[data-type="meta"] > .via{grid-column:2; grid-row:3}
    .card[data-type="meta"] > .result{grid-column:2; grid-row:4 / 7; align-self:stretch}
    .card[data-type="meta"] > .proof{grid-column:2; grid-row:7}
    .card[data-type="meta"] > .card-err{grid-column:1 / -1; grid-row:8}
  }

  /* Two results are sized as a fraction of the result box, which is right in
     a narrow column and wrong once the card spans the full grid: the canvas
     would upscale its fixed 480x300 backing store, and the colour swatch
     would stretch into a slab. Cap both at the canvas's native width so a
     wide card shows a bigger result, not a blurrier or clumsier one. */
  .card[data-type="meta"] .result canvas,
  .card[data-type="meta"] .result .swatch{max-width:480px}

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
  /* Scoped to number inputs on purpose: the meta chooser's pool checkboxes
     also live inside a .ctl, and an unscoped width blew them up to 92px. */
  .ctl input[type="number"]{
    width:92px; background:var(--void); border:1px solid var(--rule);
    color:var(--text); font-family:var(--mono); font-size:13px; padding:5px 8px;
  }
  .ctl input:focus{outline:1px solid var(--entropy)}

  .dice-back{align-self:flex-start; font-size:11px; color:var(--faint)}
  .dice-presets{display:flex; flex-wrap:wrap; gap:7px}
  .dice-presets button,.dice-add,.dice-reroll{
    background:var(--void); border:1px solid var(--rule); color:var(--text);
    font-family:var(--mono); font-size:11px; padding:7px 10px; cursor:pointer;
  }
  .dice-presets button:hover:not(:disabled),.dice-add:hover:not(:disabled),.dice-reroll:hover:not(:disabled){
    border-color:var(--entropy); color:#E4EAF0;
  }
  .dice-presets button:disabled,.dice-add:disabled,.dice-reroll:disabled{opacity:.45; cursor:wait}
  .dice-presets button:focus-visible,.dice-add:focus-visible,.dice-reroll:focus-visible{
    outline:2px solid var(--entropy); outline-offset:2px;
  }
  .dice-custom{display:flex; flex-wrap:wrap; align-items:end; gap:10px}
  .dice-custom label{
    display:flex; flex-direction:column; gap:4px; color:var(--dim);
    font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  }
  .dice-custom input{
    width:130px; background:var(--void); border:1px solid var(--rule);
    color:var(--text); font-family:var(--mono); font-size:13px; padding:7px 8px;
  }
  .dice-custom input:focus{outline:1px solid var(--entropy)}
  .dice-tray{
    display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px;
  }
  .die{
    min-width:0; border:1px solid var(--rule); background:var(--void);
    padding:12px; display:flex; flex-direction:column; align-items:center; gap:9px;
  }
  .die-face{
    width:82px; height:82px; border:1px solid var(--faint); border-radius:12px;
    display:flex; align-items:center; justify-content:center; padding:8px;
    color:#E4EAF0; font-family:var(--serif); font-size:25px; text-align:center;
    font-variant-numeric:tabular-nums; word-break:break-word; overflow:hidden;
    line-height:1.05;
  }
  .die-face.unrolled{font-family:var(--mono); font-size:16px; color:var(--dim)}
  .die-face.number-face.die-face-long{font-size:9px; letter-spacing:-.02em; white-space:nowrap}
  .die-face.pip-face{position:relative; display:grid; grid-template:repeat(3,1fr)/repeat(3,1fr); padding:13px}
  .dice-value-label{
    position:absolute; width:1px; height:1px; padding:0; margin:-1px;
    overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0;
  }
  .pip{width:10px; height:10px; border-radius:50%; background:var(--gold); place-self:center}
  .pip-1{grid-area:1/1}.pip-2{grid-area:1/2}.pip-3{grid-area:1/3}
  .pip-4{grid-area:2/1}.pip-5{grid-area:2/2}.pip-6{grid-area:2/3}
  .pip-7{grid-area:3/1}.pip-8{grid-area:3/2}.pip-9{grid-area:3/3}
  .die-label{font-size:10px; color:var(--dim); letter-spacing:.08em; word-break:break-word; text-align:center}
  .die .proof{width:100%; min-height:34px; text-align:center; letter-spacing:.06em; text-transform:none}
  .dice-reroll{width:100%}
  .dice-cap{min-height:18px; color:var(--dim); font-size:11px}

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
    word-break:break-word;
  }
  .via,.proof{
    color:var(--faint); font-size:10.5px; letter-spacing:.12em;
    text-transform:uppercase; min-height:14px;
    word-break:break-word;
  }
  .proof .unverified{color:#E06A3F}

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

  /* Builder's credit. The oxide period inside the mark is the only colour
     in the footer, and the only thing that does not shift on hover -- that
     is what makes it read as a mark rather than as decoration. */
  .built{color:var(--dim); border-bottom:0}
  .built:hover{color:var(--text); border-bottom:0}
  /* Sized against the footer's cap height, not its font-size: the viewBox is
     tight to the glyphs, so 1em would render the mark at twice the height of
     the surrounding mono text. 0.78em lands ~1.3x cap height, which reads as
     a mark beside the text rather than a heading above it. */
  .built svg{height:.78em; width:auto; vertical-align:baseline; margin-left:.3em}

  .notfound{margin-top:60px}
  .notfound h1{
    font-family:var(--serif); font-weight:400; font-size:31px; color:#E4EAF0;
    margin:0 0 14px;
  }
  .notfound p{font-family:var(--serif); font-size:17px; color:var(--dim)}

  .verify{margin-top:40px; max-width:640px}
  .verify h1{
    font-family:var(--serif); font-weight:400; font-size:31px; color:#E4EAF0;
    margin:0 0 14px;
  }
  .verify p{font-family:var(--serif); font-size:16px; color:var(--dim)}
  .verify form{display:flex; flex-direction:column; gap:10px; margin:22px 0 16px}
  .verify label{
    display:flex; flex-direction:column; gap:4px;
    color:var(--dim); font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  }
  .verify input{
    background:var(--void); border:1px solid var(--rule); color:var(--text);
    font-family:var(--mono); font-size:13px; padding:8px 10px;
  }
  .verify input:focus{outline:1px solid var(--entropy)}
  .verify .row{display:flex; gap:10px}
  .verify .row label{flex:1}
  .verify button.strike{align-self:flex-start}
  .verdict{min-height:20px; font-size:13px; word-break:break-word}
  .verdict.ok{color:var(--entropy)}
  .verdict.err{color:#E06A3F}
  .drand-link{font-size:11px; color:var(--faint)}

  @media (prefers-reduced-motion:reduce){
    *{animation:none !important; transition:none !important}
  }
  @media (max-width:480px){
    .dice-custom label{flex:1 1 100px}
    .dice-custom input{width:100%}
    .dice-add{flex:1 1 100%}
  }
`;

const CLIENT_SCRIPT = `
(function(){
  var HEX = "0123456789abcdef";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var LISTS = __LISTS__;
  var CHOOSERS = __CHOOSERS__;
  __POOL_FN__
  var SHAPE_COLORS = __SHAPE_COLORS__;
  __DERIVE_FN__
  var BEACON_URL = "https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/";
  // Poll cadence, injected from the server's beaconTiming so there is one
  // source of truth.
  var BEACON_INTERVAL_MS = __BEACON_INTERVAL_MS__;
  var BEACON_CAP_MS = __BEACON_CAP_MS__;

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

  /* verifiable randomness: commit to a drand round, wait, derive ------ */

  function sleep(ms){
    return new Promise(function(resolve){ setTimeout(resolve, ms); });
  }

  // 8 random bytes as hex, minted at commit time. The committed round is
  // unpublished at commit on the gateway path this press is using (see
  // probeBeaconRound); another anycast backend may already serve it --
  // that is the documented limit of the guarantee.
  function mintNonce(){
    var b = new Uint8Array(8);
    crypto.getRandomValues(b);
    var h = "";
    for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return h;
  }

  // Poll the committed round until published; null after the cap means
  // the beacon stalled (a backend flip can put publication past the cap)
  // and the pick falls back to a local one, badged "unverified". A 200
  // without randomness counts as not-yet-ready and keeps polling, same
  // as the server. Each attempt gets ~6s so a blackholed fetch cannot
  // pin the card on "awaiting beacon".
  function fetchBeacon(round){
    var start = Date.now();
    var attempt = 0;
    function attemptFetch(){
      // The query busts the gateway's per-node caches: a first 404 is
      // cached ~27s on some nodes, which would otherwise hide the
      // publication from our own later polls.
      attempt++;
      var req = fetch(BEACON_URL + round + "?p=" + round + "-" + attempt)
        .then(function(res){
          if (!res.ok) throw new Error("round not published");
          return res.json();
        });
      return Promise.race([req, sleep(6000).then(function(){ return null; })])
        .then(function(j){
          if (j && j.randomness) return String(j.randomness);
          throw new Error("not ready");
        })
        .catch(function(){
          if (Date.now() - start > BEACON_CAP_MS) return null;
          return sleep(BEACON_INTERVAL_MS).then(attemptFetch);
        });
    }
    return attemptFetch();
  }

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

  function proofEl(card){ return card.querySelector(".proof"); }
  function clearProof(card){
    var p = proofEl(card);
    if (p) p.innerHTML = "";
  }

  // The badge under the result: a /verify link carrying everything a
  // verifier needs, or a plain "unverified" for fallback picks. via is
  // set when a meta pick spent draw 0 choosing the chooser; min/max only
  // ride along when the number bounds are not the 1-100 default.
  // proof.round comes from a server response, so it is coerced before
  // anywhere near innerHTML.
  function showProof(card, proof){
    var p = proofEl(card);
    if (!p) return;
    var round = proof && parseInt(proof.round, 10);
    if (!proof || !isFinite(round)) {
      p.innerHTML = '<span class="unverified">unverified</span>';
      return;
    }
    var href =
      "/verify?slug=" + encodeURIComponent(proof.slug) +
      "&round=" + round +
      "&nonce=" + encodeURIComponent(proof.nonce) +
      "&item=" + encodeURIComponent(proof.item);
    if (proof.via) href += "&via=" + encodeURIComponent(proof.via);
    if (proof.min != null && (proof.min !== 1 || proof.max !== 100)) {
      href += "&min=" + proof.min + "&max=" + proof.max;
    }
    p.innerHTML = '<a href="' + href + '">verified &middot; round ' + round + "</a>";
  }

  function pendingBeacon(card, round){
    var r = resultEl(card);
    r.className = "result";
    r.innerHTML = '<span class="hint">awaiting beacon' + (round ? " round " + round : "") + "&hellip;</span>";
  }

  function textResult(card, text, big){
    var r = resultEl(card);
    r.className = "result";
    r.innerHTML = '<span class="' + (big ? "big" : "") + '"></span>';
    scramble(r.firstChild, text);
  }

  /* built-in: number ----------------------------------------------- */
  function numberBounds(card){
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
    return { a: a, b: b };
  }
  function pressNumber(card){
    var nb = numberBounds(card);
    textResult(card, String(randInt(nb.a, nb.b)), true);
  }

  /* built-in: color ------------------------------------------------ */
  function renderColorResult(card, hex){
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
  function pressColor(card){
    var hex = "#";
    for (var i = 0; i < 6; i++) hex += HEX[randInt(0, 15)];
    renderColorResult(card, hex);
  }

  /* built-in: shape ------------------------------------------------ */
  // n/color/filled decide the polygon; the angle and radius jitter stays
  // cosmetic local randomness and is no part of the verified item.
  function drawShape(card, n, color, filled){
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
    var cx = W / 2, cy = H / 2, base = Math.min(W, H) * 0.36;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2 + rand() * 0.35;
      var rad = base * (0.45 + rand() * 0.75);
      var x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    if (filled) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 + rand() * 4;
      ctx.stroke();
    }
  }
  // Renders a derived shape from its item string, so the text form (what
  // /verify checks) and the drawing can never drift apart.
  function renderShapeResult(card, item){
    var m = /(\d+)-sided polygon in (#[0-9A-Fa-f]{6}), (filled|outlined)/.exec(item);
    if (!m) { textResult(card, item, false); return; }
    drawShape(card, parseInt(m[1], 10), m[2], m[3] === "filled");
  }
  function pressShape(card){
    drawShape(card, randInt(3, 9), pick(SHAPE_COLORS), rand() < 0.5);
  }

  // Renders a derived item in the card's usual form: swatch for color,
  // canvas for shape, text otherwise.
  function renderItem(card, type, item){
    if (type === "color") renderColorResult(card, item);
    else if (type === "shape") renderShapeResult(card, item);
    else textResult(card, item, type === "number");
  }

  // The pre-beacon local pick, now the fallback path whenever the beacon
  // cannot be reached. Always badged "unverified" by the caller.
  function localBuiltin(card, slug, type){
    if (type === "number") pressNumber(card);
    else if (type === "color") pressColor(card);
    else if (type === "shape") pressShape(card);
    else pressList(card, slug);
  }

  /* built-in: list ------------------------------------------------- */
  function pressList(card, slug){
    var items = LISTS[slug] || [];
    if (!items.length) { showErr(card, "no list loaded"); return; }
    textResult(card, pick(items), false);
  }

  /* commit-reveal for built-in presses ------------------------------ */
  // Commit to the first round this gateway path will not serve yet,
  // wait for it, and derive the pick from it (draw 0 onward; the meta
  // chooser has its own flow with base 1). Any failure -- beacon down,
  // round never published, span too wide -- falls back to a local pick
  // badged "unverified"; a press must never break the card or leave its
  // button disabled.
  function pressVerified(card, slug, btn){
    var type = card.getAttribute("data-type");
    var desc = { type: type };
    if (type === "list") {
      desc.items = LISTS[slug] || [];
      if (!desc.items.length) { showErr(card, "no list loaded"); return; }
    }
    if (type === "number") {
      var nb = numberBounds(card);
      desc.min = nb.a;
      desc.max = nb.b;
      if (nb.b - nb.a + 1 > 4294967296) {
        // A span wider than 2^32 cannot be drawn from 32-bit hash words.
        localBuiltin(card, slug, type);
        showProof(card, null);
        return;
      }
    }
    btn.disabled = true;
    showErr(card, "");
    clearProof(card);
    pendingBeacon(card, 0); // generic until the probe picks the round
    var nonce = mintNonce();
    function fallback(){
      localBuiltin(card, slug, type);
      showProof(card, null);
    }
    function rescue(){
      // The fallback itself must not be able to strand the button.
      try { fallback(); }
      catch (e2) { showErr(card, "no pick: " + (e2 && e2.message ? e2.message : e2)); }
    }
    // The probe call is wrapped so even a SYNCHRONOUS throw (a broken
    // bundle was exactly this, 2026-07-29) becomes a rejection that the
    // rescue catches, instead of stranding the card on "awaiting beacon".
    Promise.resolve()
      .then(function () { return probeBeaconRound(BEACON_URL, fetch); })
      .then(function(round){
        if (round === null) { fallback(); return null; }
        pendingBeacon(card, round);
        return fetchBeacon(round).then(function(randomness){
          if (!randomness) { fallback(); return null; }
          return deriveItem(desc, SHAPE_COLORS, randomness, nonce, slug, 0)
            .then(function(item){
              if (item == null) { fallback(); return; }
              renderItem(card, type, item);
              showProof(card, {
                slug: slug, round: round, nonce: nonce, item: item,
                min: desc.min, max: desc.max
              });
            });
        });
      })
      .catch(rescue)
      .then(function(){ btn.disabled = false; });
  }

  /* dice tray -------------------------------------------------------- */
  // This is the same numeric acceptance core as server boundFromParam and
  // numberBounds.clamped: parseFloat, finite-only, round, clamp +/-1e12.
  function diceBound(raw){
    var n = parseFloat(raw);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n > 1e12) n = 1e12;
    if (n < -1e12) n = -1e12;
    return n;
  }

  function dieFromElement(tile){
    var min = diceBound(tile.getAttribute("data-min"));
    var max = diceBound(tile.getAttribute("data-max"));
    if (min === null || max === null) return null;
    return { min: min, max: max };
  }

  function diceTiles(card){
    return card.querySelectorAll(".die[data-min][data-max]");
  }

  // Sorting is roll-only. The rendered attributes and the share URL always
  // keep the order supplied by the tray owner.
  function diceOrdered(die){
    return die.min <= die.max
      ? { min: die.min, max: die.max }
      : { min: die.max, max: die.min };
  }

  function diceLabel(die){
    if (die.min === 1 && die.max === 2) return "coin";
    if (die.min === 1 && die.max > die.min) return "d" + die.max;
    return die.min + "\u2013" + die.max;
  }

  function diceParam(die){
    return die.min === 1 ? String(die.max) : String(die.min) + "-" + String(die.max);
  }

  function diceTileMarkup(die){
    var label = diceLabel(die);
    return '<div class="die" data-min="' + esc(die.min) + '" data-max="' + esc(die.max) + '">' +
      '<div class="die-face unrolled">' + esc(label) + "</div>" +
      '<div class="die-label" aria-hidden="true">' + esc(label) + "</div>" +
      '<div class="proof"></div>' +
      '<button class="dice-reroll dice-roll-control" type="button" aria-label="Re-roll ' +
      esc(label) + '">Re-roll</button></div>';
  }

  function syncDiceUrl(card){
    var url = new URL(window.location.href);
    url.searchParams.delete("d");
    var tiles = diceTiles(card);
    for (var i = 0; i < tiles.length; i++) {
      var die = dieFromElement(tiles[i]);
      if (die) url.searchParams.append("d", diceParam(die));
    }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  function clearDieProof(tile){
    var p = tile.querySelector(".proof");
    if (p) p.innerHTML = "";
  }

  // A dice badge carries the whole rendered tray and the target's original
  // index. The tray values stay unswapped here; /verify orders only the
  // selected die before deriving it. Any incomplete proof stays unverified.
  function showDieProof(tile, proof){
    var p = tile.querySelector(".proof");
    if (!p) return;
    var drawRaw = proof && proof.draw;
    var itemRaw = proof && proof.item;
    var round = proof && Number(proof.round);
    var draw = drawRaw === null || drawRaw === undefined || String(drawRaw).trim() === ""
      ? NaN : Number(drawRaw);
    var item = itemRaw === null || itemRaw === undefined || String(itemRaw).trim() === ""
      ? NaN : Number(itemRaw);
    var nonce = proof && typeof proof.nonce === "string" ? proof.nonce : "";
    var tray = proof && proof.dice;
    if (!proof || !isFinite(round) || Math.floor(round) !== round || !(round > 0) ||
        !/^[0-9a-f]{16}$/.test(nonce) || !isFinite(draw) || Math.floor(draw) !== draw ||
        !isFinite(item) || Math.floor(item) !== item ||
        !Array.isArray(tray) || !tray.length || tray.length > 24 ||
        draw < 0 || draw >= tray.length) {
      p.innerHTML = '<span class="unverified">unverified</span>';
      return;
    }
    var params = [];
    var target = null;
    var targetRendered = null;
    for (var i = 0; i < tray.length; i++) {
      var min = diceBound(tray[i] && tray[i].min);
      var max = diceBound(tray[i] && tray[i].max);
      if (min === null || max === null) {
        p.innerHTML = '<span class="unverified">unverified</span>';
        return;
      }
      var rendered = { min: min, max: max };
      params.push(diceParam(rendered));
      if (i === draw) {
        targetRendered = rendered;
        target = diceOrdered(rendered);
      }
    }
    if (!target || target.max - target.min + 1 > 4294967296 ||
        item < target.min || item > target.max) {
      p.innerHTML = '<span class="unverified">unverified</span>';
      return;
    }
    var href =
      "/verify?slug=" + encodeURIComponent("dice") +
      "&round=" + encodeURIComponent(String(round)) +
      "&nonce=" + encodeURIComponent(nonce) +
      "&item=" + encodeURIComponent(String(item)) +
      "&draw=" + encodeURIComponent(String(draw));
    for (var k = 0; k < params.length; k++) {
      href += "&d=" + encodeURIComponent(params[k]);
    }
    var label = "Verify " + diceLabel(targetRendered) + " result at tray draw " +
      draw + ", round " + round;
    p.innerHTML = '<a href="' + href + '" aria-label="' + esc(label) +
      '">verified &middot; round ' + round + "</a>";
  }

  function pendingDie(tile, round){
    var face = tile.querySelector(".die-face");
    if (!face) return;
    face.className = "die-face unrolled";
    face.textContent = "awaiting beacon" + (round ? " round " + round : "") + "\u2026";
  }

  function renderDieResult(tile, value){
    var face = tile.querySelector(".die-face");
    var rendered = dieFromElement(tile);
    if (!face || !rendered) return;
    // Special faces key on the bounds AS RENDERED, matching the labels: a
    // reversed (2,1) or (6,1) die keeps a numbered tile, not coin or pips.
    if (rendered.min === 1 && rendered.max === 2) {
      face.className = "die-face coin-face";
      face.textContent = Number(value) === 1 ? "Heads" : "Tails";
      return;
    }
    if (rendered.min === 1 && rendered.max === 6) {
      var positions = {
        1: [5], 2: [1, 9], 3: [1, 5, 9],
        4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9]
      };
      var pips = positions[Number(value)] || [];
      var markup = '<span class="dice-value-label">' + String(Number(value)) + "</span>";
      for (var i = 0; i < pips.length; i++) {
        markup += '<span class="pip pip-' + pips[i] + '" aria-hidden="true"></span>';
      }
      face.className = "die-face pip-face";
      face.innerHTML = markup;
      return;
    }
    var numberText = String(value);
    face.className = "die-face number-face" + (numberText.length > 6 ? " die-face-long" : "");
    face.textContent = numberText;
  }

  function localDie(die){
    return randInt(die.min, die.max);
  }

  function fallbackDie(tile, die){
    renderDieResult(tile, localDie(die));
    showDieProof(tile, null);
  }

  function setDiceBusy(card, busy){
    card._diceBusy = !!busy;
    var controls = card.querySelectorAll(".dice-roll-control,.dice-preset,.dice-add");
    for (var i = 0; i < controls.length; i++) controls[i].disabled = !!busy;
    var inputs = card.querySelectorAll(".dice-custom input");
    for (var k = 0; k < inputs.length; k++) inputs[k].disabled = !!busy;
    if (!busy) {
      var all = card.querySelector(".dice-roll-all");
      if (all) all.disabled = diceTiles(card).length === 0;
    }
  }

  function rollDiceAll(card){
    if (card._diceBusy) return Promise.resolve(false);
    var tiles = diceTiles(card);
    if (!tiles.length) {
      setDiceBusy(card, false);
      return Promise.resolve(false);
    }
    var entries = [];
    var tray = [];
    var proofableTray = tiles.length <= 24;
    for (var i = 0; i < tiles.length; i++) {
      var rendered = dieFromElement(tiles[i]);
      if (rendered) {
        tray.push({ min: rendered.min, max: rendered.max });
        entries.push({ tile: tiles[i], die: diceOrdered(rendered), index: i });
      } else {
        proofableTray = false;
      }
    }
    if (!entries.length) {
      setDiceBusy(card, false);
      return Promise.resolve(false);
    }

    setDiceBusy(card, true);
    showErr(card, "");
    var eligible = [];
    for (var k = 0; k < entries.length; k++) {
      clearDieProof(entries[k].tile);
      if (entries[k].die.max - entries[k].die.min + 1 > 4294967296) {
        fallbackDie(entries[k].tile, entries[k].die);
      } else {
        pendingDie(entries[k].tile, 0);
        eligible.push(entries[k]);
      }
    }
    // No commit exists when every die exceeds the derivation limit.
    if (!eligible.length) {
      setDiceBusy(card, false);
      return Promise.resolve(true);
    }

    var nonce = mintNonce();
    function fallback(){
      for (var j = 0; j < eligible.length; j++) fallbackDie(eligible[j].tile, eligible[j].die);
    }
    function rescue(e){
      try { fallback(); }
      catch (e2) { showErr(card, "no roll: " + (e2 && e2.message ? e2.message : e2)); }
    }
    return Promise.resolve()
      .then(function () { return probeBeaconRound(BEACON_URL, fetch); })
      .then(function(round){
        if (round === null) { fallback(); return null; }
        for (var j = 0; j < eligible.length; j++) pendingDie(eligible[j].tile, round);
        return fetchBeacon(round).then(function(randomness){
          if (!randomness) { fallback(); return null; }
          var draws = [];
          for (var m = 0; m < eligible.length; m++) {
            draws.push(deriveDie(
              randomness, nonce, eligible[m].index,
              eligible[m].die.min, eligible[m].die.max
            ));
          }
          return Promise.all(draws).then(function(values){
            for (var n = 0; n < eligible.length; n++) {
              if (values[n] === null) {
                fallbackDie(eligible[n].tile, eligible[n].die);
              } else {
                renderDieResult(eligible[n].tile, values[n]);
                showDieProof(eligible[n].tile, {
                  round: round, nonce: nonce, item: values[n],
                  draw: eligible[n].index, dice: proofableTray ? tray : null
                });
              }
            }
          });
        });
      })
      .catch(rescue)
      .then(function(){ setDiceBusy(card, false); return true; });
  }

  function rerollDie(card, tile){
    if (card._diceBusy) return Promise.resolve(false);
    var rendered = dieFromElement(tile);
    if (!rendered) return Promise.resolve(false);
    var die = diceOrdered(rendered);
    showErr(card, "");
    if (die.max - die.min + 1 > 4294967296) {
      fallbackDie(tile, die);
      return Promise.resolve(true);
    }

    setDiceBusy(card, true);
    clearDieProof(tile);
    pendingDie(tile, 0);
    var nonce = mintNonce();
    function fallback(){ fallbackDie(tile, die); }
    function rescue(e){
      try { fallback(); }
      catch (e2) { showErr(card, "no roll: " + (e2 && e2.message ? e2.message : e2)); }
    }
    return Promise.resolve()
      .then(function () { return probeBeaconRound(BEACON_URL, fetch); })
      .then(function(round){
        if (round === null) { fallback(); return null; }
        pendingDie(tile, round);
        return fetchBeacon(round).then(function(randomness){
          if (!randomness) { fallback(); return null; }
          return deriveDie(randomness, nonce, 0, die.min, die.max)
            .then(function(value){
              if (value === null) { fallback(); return; }
              renderDieResult(tile, value);
              showDieProof(tile, {
                round: round, nonce: nonce, item: value, draw: 0,
                dice: [{ min: rendered.min, max: rendered.max }]
              });
            });
        });
      })
      .catch(rescue)
      .then(function(){ setDiceBusy(card, false); return true; });
  }

  function bindDieReroll(card, tile){
    if (tile._diceRerollBound) return;
    tile._diceRerollBound = true;
    var btn = tile.querySelector(".dice-reroll");
    if (!btn) return;
    btn.addEventListener("click", function(){ rerollDie(card, tile); });
  }

  function addDie(card, die){
    var min = diceBound(die && die.min);
    var max = diceBound(die && die.max);
    if (min === null || max === null) {
      showErr(card, "enter a finite minimum and maximum");
      return null;
    }
    if (diceTiles(card).length >= 24) {
      var full = card.querySelector(".dice-cap");
      if (full) full.textContent = "tray holds 24 dice; this one was not added.";
      showErr(card, "");
      return null;
    }
    var tray = card.querySelector(".dice-tray");
    if (!tray) return null;
    var wrap = document.createElement("div");
    wrap.innerHTML = diceTileMarkup({ min: min, max: max });
    var tile = wrap.firstChild;
    tray.appendChild(tile);
    bindDieReroll(card, tile);
    var cap = card.querySelector(".dice-cap");
    if (cap) cap.textContent = "";
    showErr(card, "");
    var rollAll = card.querySelector(".dice-roll-all");
    if (rollAll && !card._diceBusy) rollAll.disabled = false;
    syncDiceUrl(card);
    return tile;
  }

  function bindDice(card){
    var tiles = diceTiles(card);
    for (var i = 0; i < tiles.length; i++) bindDieReroll(card, tiles[i]);

    var rollAll = card.querySelector(".dice-roll-all");
    if (rollAll) rollAll.addEventListener("click", function(){ rollDiceAll(card); });

    var presets = card.querySelectorAll(".dice-preset");
    for (var k = 0; k < presets.length; k++) {
      (function(btn){
        btn.addEventListener("click", function(){
          if (card._diceBusy) return;
          addDie(card, { min: btn.getAttribute("data-min"), max: btn.getAttribute("data-max") });
        });
      })(presets[k]);
    }

    var add = card.querySelector(".dice-add");
    var minIn = card.querySelector(".dice-custom-min");
    var maxIn = card.querySelector(".dice-custom-max");
    if (add && minIn && maxIn) {
      add.addEventListener("click", function(){
        if (card._diceBusy) return;
        var min = diceBound(minIn.value);
        var max = diceBound(maxIn.value);
        if (min === null || max === null) {
          showErr(card, "enter a finite minimum and maximum");
          return;
        }
        minIn.value = min;
        maxIn.value = max;
        addDie(card, { min: min, max: max });
      });
    }
    setDiceBusy(card, false);
  }

  /* The card a result renders into is not always the card that owns the
     counter: the meta chooser shows its pick in its own card, but the press
     belongs to whichever chooser it landed on. Address the counter by slug. */
  function setCount(slug, n){
    var cards = document.querySelectorAll(".card[data-slug]");
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute("data-slug") !== slug) continue;
      var c = cards[i].querySelector(".count");
      if (c) c.textContent = n + (n === 1 ? " press" : " presses");
    }
  }

  /* user chooser: server pick -------------------------------------- */
  // The server does its own commit-reveal; the badge carries the proof
  // from its response (proof: null when the beacon failed server-side).
  function pressKv(card, slug, btn){
    btn.disabled = true;
    clearProof(card);
    var ok = true;
    return fetch("/api/pick/" + encodeURIComponent(slug), { method: "POST" })
      .then(function(res){
        return res.json().then(function(j){ return { ok: res.ok, j: j }; });
      })
      .then(function(r){
        if (!r.ok) throw new Error(r.j && r.j.error ? r.j.error : "HTTP error");
        textResult(card, r.j.item, false);
        showProof(card, r.j.proof
          ? { slug: slug, round: r.j.proof.round, nonce: r.j.proof.nonce, item: r.j.item }
          : null);
        if (typeof r.j.count === "number") setCount(slug, r.j.count);
      })
      .catch(function(e){
        ok = false;
        showErr(card, "no pick: " + e.message);
      })
      .finally(function(){
        btn.disabled = false;
      })
      .then(function(){
        return ok;
      });
  }

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

  function bindMeta(card){
    var state = loadPool();
    var bEl = card.querySelector(".pool-builtins");
    var uEl = card.querySelector(".pool-users");
    var listEl = card.querySelector(".pool-list");
    var viaEl = card.querySelector(".via");
    var btn = card.querySelector("button.press");
    var pending = false;

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
      btn.disabled = pending || pool.length === 0;
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
      clearProof(card);
      pending = true;
      refresh();
      pendingBeacon(card, 0); // generic until the probe picks the round
      var nonce = mintNonce();
      // Wrapped like pressVerified: a synchronous throw from the probe
      // must reach the catch below, not strand the meta button.
      Promise.resolve()
        .then(function () { return probeBeaconRound(BEACON_URL, fetch); })
        .then(function(round){
          if (round === null) return finish(pick(pool), null);
          pendingBeacon(card, round);
          return fetchBeacon(round).then(function(randomness){
            if (!randomness) return finish(pick(pool), null);
            // Draw 0 chooses the chooser, draw 1 the item -- one round,
            // one nonce, exactly what /verify recomputes with via=random.
            return derivePick(randomness, nonce, "random", 0, pool.length)
              .then(function(i){
                return finish(pool[i], { round: round, nonce: nonce, randomness: randomness });
              });
          });
        })
        .catch(function(){
          // Same rule as pressVerified: a throwing fallback must not
          // strand the meta button in the disabled state.
          try { return finish(pick(pool), null); }
          catch (e) { showErr(card, "no pick: " + (e && e.message ? e.message : e)); return null; }
        })
        .then(function(){
          pending = false;
          refresh();
        });
    });

    function finish(chosen, beacon){
      if (chosen.kind === "builtin") {
        viaEl.textContent = "via " + chosen.name;
        if (!beacon) {
          localBuiltin(card, chosen.slug, chosen.type);
          showProof(card, null);
          return null;
        }
        var desc = { type: chosen.type };
        if (chosen.type === "list") desc.items = LISTS[chosen.slug] || [];
        // The meta card has no bounds inputs; number keeps its 1-100
        // default, matching the server-side pick of the same chooser.
        return deriveItem(desc, SHAPE_COLORS, beacon.randomness, beacon.nonce, chosen.slug, 1)
          .then(function(item){
            if (item == null) {
              localBuiltin(card, chosen.slug, chosen.type);
              showProof(card, null);
              return;
            }
            renderItem(card, chosen.type, item);
            showProof(card, {
              slug: chosen.slug, round: beacon.round, nonce: beacon.nonce,
              item: item, via: "random"
            });
          });
      }
      // A visitor-made chooser is a real server press with its own
      // commit-reveal; the badge carries that response's proof.
      return pressKv(card, chosen.slug, btn).then(function(ok){
        viaEl.textContent = ok ? "via " + chosen.name : "";
      });
    }
  }

  function bindCard(card){
    var btn = card.querySelector("button.press");
    if (!btn) return;
    var slug = card.getAttribute("data-slug");
    var kind = card.getAttribute("data-kind");
    var type = card.getAttribute("data-type");
    if (type === "meta") { bindMeta(card); return; }
    btn.addEventListener("click", function(){
      showErr(card, "");
      if (kind === "builtin") {
        pressVerified(card, slug, btn);
      } else {
        pressKv(card, slug, btn);
      }
    });
  }

  var cards = document.querySelectorAll(".card[data-slug]");
  for (var i = 0; i < cards.length; i++) bindCard(cards[i]);
  var diceCard = document.querySelector('.card[data-type="dice"]');
  if (diceCard) bindDice(diceCard);

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
      status.textContent = "verifying and generating the whole list; this can take up to a couple of minutes. hold on.";
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
      '<div class="blurb">a generated list, fixed forever</div>' +
      '<div class="result" aria-live="polite"><span class="hint">&mdash; press &mdash;</span></div>' +
      '<div class="proof" aria-live="polite"></div>' +
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

// JSON destined for a <script> body: "</script>" inside a string value ends
// the element, so "<" must be escaped. Same guard listsJson and ldJson use.
function scriptJson(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

function page(opts) {
  const title = opts.title;
  const desc = opts.desc;
  const canonical = opts.canonical;
  const listsJson = scriptJson({
    animal: ANIMALS,
    "simpsons-character": SIMPSONS,
  });
  const ldJson = scriptJson({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "random choosers",
    url: "https://random.oddspark.dev/",
    image: SOCIAL_URL,
    description:
      "A shelf of random choosers: number, color, shape, animal, simpsons character, plus choosers named by visitors with AI-generated lists.",
  });

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
<meta property="og:image" content="${SOCIAL_URL}">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta property="og:image:alt" content="A dark shelf of cards, one wide card above five smaller ones, under the words random choosers.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${SOCIAL_URL}">
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
    <a href="/verify">verify</a>
    <a href="/dice/">dice</a>
    <span>random.oddspark.dev</span>
    <span>built-ins run in your browser; the rest are one press each</span>
    <a class="built" href="https://hearn.systems" rel="noopener">built by ${HEARN_MARK}</a>
  </footer>

</div>

<script>${CLIENT_SCRIPT
  .replace("__LISTS__", function () { return listsJson; })
  .replace("__CHOOSERS__", function () { return scriptJson(opts.choosers || []); })
  .replace("__POOL_FN__", function () { return computePool.toString(); })
  .replace("__SHAPE_COLORS__", function () { return scriptJson(SHAPE_COLORS); })
  .replace("__DERIVE_FN__", function () { return DERIVE_FNS_SRC_TEXT; })
  .replace("__BEACON_INTERVAL_MS__", function () { return String(beaconTiming.intervalMs); })
  .replace("__BEACON_CAP_MS__", function () { return String(beaconTiming.capMs); })}</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * /verify: independent recomputation of any verified pick.
 *
 * The page is deliberately dumb: the form is prefilled from the query
 * string (badge links land ready to run), the visitor's browser fetches
 * the round from drand directly (CORS is open), and the same injected
 * DERIVE_FNS the press ran recomputes the item. No BLS verification in
 * page -- the verdict links out to the beacon round instead.
 * ------------------------------------------------------------------ */

// Chooser slug -> derivation scheme, built from the table so a new
// built-in cannot drift. Unknown (visitor-made) slugs are lists.
const VERIFY_TYPES = Object.fromEntries(BUILTINS.map((b) => [b.slug, b.type]));

/* Same constraint as CLIENT_SCRIPT: string concatenation only inside. */
const VERIFY_SCRIPT = `
(function(){
  __DERIVE_FN__
  var TYPES = __VERIFY_TYPES__;
  var PALETTE = __SHAPE_COLORS__;
  var BEACON_URL = "https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/";
  var FIELDS = ["slug", "round", "nonce", "item", "via", "min", "max", "draw"];

  function el(id){ return document.getElementById("v-" + id); }
  function say(msg, cls){
    var v = document.getElementById("verdict");
    v.className = "verdict" + (cls ? " " + cls : "");
    v.textContent = msg;
  }

  // Prefill from the query string; badge links land here ready to run.
  var q = new URLSearchParams(location.search);
  for (var i = 0; i < FIELDS.length; i++) {
    var val = q.get(FIELDS[i]);
    if (val !== null) el(FIELDS[i]).value = val;
  }
  var queryDice = q.getAll("d");
  if (queryDice.length) {
    el("dice").value = queryDice.join(", ");
    // Preserve exact repeated query components for the initial auto-run;
    // the visible comma-separated field is only an editing convenience.
    el("dice")._queryDice = queryDice;
    el("dice")._queryValue = el("dice").value;
  }

  function verifyBound(raw){
    var n = parseFloat(raw);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n > 1e12) n = 1e12;
    if (n < -1e12) n = -1e12;
    return n;
  }

  // Mirrors server dieFromParam: a leading hyphen is a sign; the first
  // later hyphen separates an explicit, deliberately unswapped range.
  function verifyDie(raw){
    var value = String(raw).trim();
    var separator = value.indexOf("-", 1);
    if (separator === -1) {
      var max = verifyBound(value);
      return max === null ? null : { min: 1, max: max };
    }
    var min = verifyBound(value.slice(0, separator));
    var max2 = verifyBound(value.slice(separator + 1));
    return min === null || max2 === null ? null : { min: min, max: max2 };
  }

  function sleepVerify(ms){
    return new Promise(function(resolve){ setTimeout(resolve, ms); });
  }

  // Cache-busted, with retries: the press's own probe may have cached a
  // 404 for this round (~27s on some nodes), so one bare 404 is not
  // proof the round does not exist.
  function fetchRound(round){
    var attempt = 0;
    function once(){
      attempt++;
      return fetch(BEACON_URL + round + "?v=" + round + "-" + attempt)
        .then(function(res){
          if (res.status === 404 && attempt < 3) return sleepVerify(1000).then(once);
          if (!res.ok) throw new Error("the beacon answered HTTP " + res.status);
          return res.json();
        });
    }
    return once();
  }

  function run(){
    document.getElementById("drand-link").innerHTML = "";
    var slug = el("slug").value.trim().toLowerCase();
    var round = parseInt(el("round").value, 10);
    var nonce = el("nonce").value.trim();
    var item = el("item").value;
    var via = el("via").value.trim().toLowerCase();
    if (!slug || !(round > 0) || !nonce || !item) {
      say("slug, round, nonce and item are required.", "err");
      return;
    }
    var hasDiceShape = slug === "dice" &&
      (el("dice").value.trim() !== "" || el("draw").value.trim() !== "");
    var type = hasDiceShape ? "dice" : (TYPES[slug] || "list");
    if (type === "meta") {
      say("a random random pick verifies through the chooser it landed on; use the link from its badge.", "err");
      return;
    }
    var desc = { type: type };
    var diceTarget = null;
    var diceDraw = null;
    // A meta pick spent draw 0 choosing the chooser, so its item
    // draws start at 1. Direct picks start at 0.
    var base = via ? 1 : 0;
    if (type === "number") {
      desc.min = el("min").value !== "" ? Math.round(parseFloat(el("min").value)) : 1;
      desc.max = el("max").value !== "" ? Math.round(parseFloat(el("max").value)) : 100;
      if (!isFinite(desc.min) || !isFinite(desc.max)) {
        say("min and max must be numbers.", "err");
        return;
      }
      if (desc.min > desc.max) {
        // The press side swaps inverted bounds before committing, so a
        // claimed pick with min > max cannot be honest; refuse it. (An
        // empty span would make the derivation a constant and any
        // round/nonce "verify".)
        say("min must not be greater than max.", "err");
        return;
      }
    }
    if (type === "dice") {
      if (via) {
        say("via does not apply to dice.", "err");
        return;
      }
      var diceField = el("dice");
      var rawDice = diceField._queryDice && diceField.value === diceField._queryValue
        ? diceField._queryDice.slice()
        : diceField.value.split(",");
      if (!diceField.value.trim() || !rawDice.length) {
        say("a dice tray is required.", "err");
        return;
      }
      if (rawDice.length > 24) {
        say("a dice proof can contain at most 24 dice.", "err");
        return;
      }
      var dice = [];
      for (var d = 0; d < rawDice.length; d++) {
        var parsed = verifyDie(rawDice[d]);
        if (!parsed) {
          say("every die must be a finite number or min-max range.", "err");
          return;
        }
        dice.push(parsed);
      }
      var drawRaw = el("draw").value.trim();
      diceDraw = Number(drawRaw);
      if (!drawRaw || !isFinite(diceDraw) || Math.floor(diceDraw) !== diceDraw ||
          diceDraw < 0 || diceDraw >= dice.length) {
        say("draw must be a whole-number tray index.", "err");
        return;
      }
      var target = dice[diceDraw];
      diceTarget = target.min <= target.max
        ? { min: target.min, max: target.max }
        : { min: target.max, max: target.min };
      if (diceTarget.max - diceTarget.min + 1 > 4294967296) {
        say("the target die is too wide to verify.", "err");
        return;
      }
      var diceItem = Number(item);
      if (!isFinite(diceItem) || Math.floor(diceItem) !== diceItem ||
          diceItem < diceTarget.min || diceItem > diceTarget.max) {
        say("the claimed dice item must be a whole number within the target die.", "err");
        return;
      }
    }
    say("fetching beacon round " + round + "…");
    fetchRound(round)
      .then(function(j){
        if (!j || !j.randomness) throw new Error("that round is not published");
        var randomness = String(j.randomness);
        var ready = null;
        if (type === "list") {
          ready = fetch("/api/items/" + encodeURIComponent(slug))
            .then(function(r){ return r.json(); })
            .then(function(j2){
              if (!j2 || !j2.items || !j2.items.length) throw new Error("no item list for that slug");
              desc.items = j2.items;
            });
        }
        return Promise.resolve(ready)
          .then(function(){
            if (type === "dice") {
              return deriveDie(
                randomness, nonce, diceDraw, diceTarget.min, diceTarget.max
              ).then(function(value){ return value === null ? null : String(value); });
            }
            return deriveItem(desc, PALETTE, randomness, nonce, slug, base);
          })
          .then(function(computed){
            if (computed == null) { say("could not recompute a pick from those inputs.", "err"); return; }
            document.getElementById("drand-link").innerHTML =
              'randomness source: <a href="' + BEACON_URL + round + '">drand quicknet round ' + round + "</a>";
            if (computed === item) {
              say("matches — verified. round " + round + " + this nonce recomputes this exact item." +
                (via ? " (the chooser draw behind a random random press depends on the presser's pool and is not recomputable here.)" : ""), "ok");
            } else {
              say("does not verify — round " + round + " + this nonce computes \\"" + computed + "\\", not \\"" + item + "\\"." +
                (type === "list"
                  ? (TYPES[slug]
                    ? " built-in lists ship with the site and can change when the site is updated; a pick made before such an update may no longer recompute."
                    : " visitor-made lists never change, so this should have recomputed — unless the chooser was created before lists became static (July 2026), when lists rotated daily, including on the changeover day.")
                  : ""), "err");
            }
          });
      })
      .catch(function(e){
        say("could not verify: " + e.message, "err");
      });
  }

  document.getElementById("verify-form").addEventListener("submit", function(ev){
    ev.preventDefault();
    run();
  });
  if (q.get("slug") && q.get("round") && q.get("nonce") && q.get("item")) run();
})();
`;

function verifyPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>verify a pick / random choosers</title>
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
  <div class="verify">
    <h1>Verify a pick.</h1>
    <p>Every verified pick commits, together with a one-press nonce, to a drand
    quicknet round that the gateway had not published yet on the path that
    press used &mdash; a different anycast backend may already have served it,
    which is the documented limit of the guarantee. The item is then derived
    deterministically from the round&rsquo;s randomness, the nonce, the chooser
    and a draw index &mdash; so this page can recompute it independently,
    straight from the beacon. Paste the details from a pick, or follow the
    &ldquo;verified &middot; round N&rdquo; badge under any result, which fills
    this in for you.</p>
    <p>Visitor-made lists are fixed at creation and never change, so a pick
    on one recomputes forever, against the same list. Built-in lists ship
    with the site itself and can change when the site is updated, so a pick
    made before such an update may not recompute. One honest caveat for the
    old era: choosers created before lists became static (July 2026) rotated
    daily back then, including on the changeover day, so a pick from that
    era may not recompute either. That is an honest mismatch, not proof of
    rigging.</p>
    <p>Dice links also carry the complete ordered tray and the target draw
    index. The verifier keeps each die&rsquo;s displayed bound order as evidence,
    then orders only the target bounds for derivation.</p>
    <form id="verify-form">
      <div class="row">
        <label>chooser slug <input id="v-slug" autocomplete="off" placeholder="number"></label>
        <label>beacon round <input id="v-round" inputmode="numeric" autocomplete="off"></label>
      </div>
      <label>nonce <input id="v-nonce" autocomplete="off" placeholder="16 hex characters"></label>
      <label>claimed item <input id="v-item" autocomplete="off"></label>
      <div class="row">
        <label>via (optional) <input id="v-via" autocomplete="off" placeholder="random"></label>
        <label>min (number only) <input id="v-min" inputmode="numeric" autocomplete="off" placeholder="1"></label>
        <label>max (number only) <input id="v-max" inputmode="numeric" autocomplete="off" placeholder="100"></label>
      </div>
      <div class="row">
        <label>draw (dice only) <input id="v-draw" inputmode="numeric" autocomplete="off" placeholder="0"></label>
        <label>dice tray (comma-separated d values) <input id="v-dice" autocomplete="off" placeholder="6, 20, 9-3"></label>
      </div>
      <button class="strike" type="submit">Verify</button>
    </form>
    <div id="verdict" class="verdict" aria-live="polite"></div>
    <div id="drand-link" class="drand-link"></div>
  </div>
</div>
<script>${VERIFY_SCRIPT
  .replace("__DERIVE_FN__", function () { return DERIVE_FNS_SRC_TEXT; })
  .replace("__VERIFY_TYPES__", function () { return scriptJson(VERIFY_TYPES); })
  .replace("__SHAPE_COLORS__", function () { return scriptJson(SHAPE_COLORS); })}</script>
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

  // 6. store, then consume the day's rate slot. The list is immutable from
  // here on: nothing ever regenerates it.
  const slug = await freeSlug(env, slugify(name));
  const rec = {
    slug,
    name,
    kind: "user",
    items,
    created: new Date().toISOString(),
  };
  await env.CHOOSERS.put("c:" + slug, JSON.stringify(rec));
  await env.CHOOSERS.put(rl, "1", { expirationTtl: RL_TTL });

  return json({ slug, name });
}

/* ------------------------------------------------------------------ *
 * Server-side picks for the built-ins.
 *
 * The browser renders some of these richer than text allows -- color is a
 * swatch, shape is a canvas -- so these are the terminal forms. shape is
 * the only one with no natural text form: rather than drop it from the
 * pool (which would give curl different odds than the site advertises
 * under the same name), it describes the polygon it would have drawn,
 * using exactly the parameters pressShape uses.
 * ------------------------------------------------------------------ */

export function builtinPick(c) {
  if (c.type === "number") return String(1 + randomIndex(100));
  if (c.type === "color") {
    let hex = "#";
    for (let i = 0; i < 6; i++) hex += "0123456789abcdef"[randomIndex(16)];
    return hex;
  }
  if (c.type === "shape") {
    const sides = 3 + randomIndex(7); // pressShape: randInt(3, 9)
    const color = SHAPE_COLORS[randomIndex(SHAPE_COLORS.length)];
    const filled = randomIndex(2) === 0; // pressShape: rand() < 0.5
    // "an 8-sided polygon" -- eight is the only vertex count in 3..9 that
    // takes "an", since the article follows the spoken digit.
    const article = sides === 8 ? "an " : "a ";
    return article + sides + "-sided polygon in " + color + (filled ? ", filled" : ", outlined");
  }
  if (c.type === "list" && c.items && c.items.length) {
    return c.items[randomIndex(c.items.length)];
  }
  return null;
}

async function handlePick(request, env, slug) {
  const builtin = BUILTIN_MAP[slug];

  // Resolve what this press can land on BEFORE committing to a round, so
  // an unknown slug 404s immediately instead of after a beacon wait.
  // The meta chooser delegates. Its pool is per-visitor in the browser,
  // but curl carries no preferences, so the server uses the default:
  // everything except itself. computePool is the same function the
  // browser runs, so the two agree on what "everything" means --
  // including excluding the meta chooser, which stops the recursion.
  let pool = null;
  let target = null;
  if (builtin && builtin.type === "meta") {
    pool = computePool(buildManifest(await listUserChoosers(env)));
    if (!pool.length) return json({ error: "nothing to choose from" }, 503);
  } else if (!builtin) {
    target = await getUserChooser(env, slug);
    if (!target) return json({ error: "no chooser with that slug" }, 404);
  }

  // Commit: probe forward to the first round this gateway path will not
  // serve yet (probeBeaconRound), plus a nonce minted now -- so the
  // round's signature does not exist on this path when the nonce is
  // minted, and neither can be ground. A beacon failure (probe error, or
  // the round still unpublished at the poll cap) degrades to a local
  // pick with proof: null, never to an error.
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  const round = await probeBeaconRound(BEACON_URL, fetch);
  const randomness = round === null ? null : await awaitBeaconRound(round, fetch);
  const proof = randomness ? { round, nonce } : null;

  // One index per draw -- derived when the beacon answered, crypto
  // otherwise. Draw indices follow the scheme on deriveItem: meta spends
  // draw 0 on the pool, so its item draws start at 1.
  const draw = (drawSlug, drawIx, n) =>
    randomness ? derivePick(randomness, nonce, drawSlug, drawIx, n) : Promise.resolve(randomIndex(n));
  const drawItem = (c, drawSlug, base) =>
    randomness ? deriveItem(c, SHAPE_COLORS, randomness, nonce, drawSlug, base) : Promise.resolve(builtinPick(c));

  if (pool) {
    const chosen = pool[await draw("random", 0, pool.length)];
    const via = { slug: chosen.slug, name: chosen.name };
    if (chosen.kind === "builtin") {
      return json({ slug, name: builtin.name, via, item: await drawItem(BUILTIN_MAP[chosen.slug], chosen.slug, 1), proof });
    }
    // Landing on a visitor-made chooser is a real press against its
    // counter, exactly as it is in the browser.
    target = await getUserChooser(env, chosen.slug);
    if (!target) return json({ error: "no pick: chooser vanished mid-press" }, 404);
    const item = target.items[await draw(chosen.slug, 1, target.items.length)];
    const count = await hitCounter(env, chosen.slug);
    return json({ slug, name: builtin.name, via, item, count, proof });
  }

  // Built-ins have no counters, so no hitCounter call and no count field.
  if (builtin) return json({ slug, name: builtin.name, item: await drawItem(builtin, slug, 0), proof });

  const item = target.items[await draw(slug, 0, target.items.length)];
  const count = await hitCounter(env, slug);

  return json({ slug, name: target.name, item, count, proof });
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
        return await handlePick(request, env, slug);
      }

      if (path === "/api/choosers") {
        const users = await listUserChoosers(env);
        return json([
          ...BUILTINS.map((b) => ({ slug: b.slug, name: b.name, kind: "builtin" })),
          ...users.map((u) => ({ slug: u.slug, name: u.name, kind: "user" })),
        ]);
      }

      if (path.startsWith("/api/items/")) {
        // The item list a /verify recomputation draws from. Works for the
        // list built-ins too, so the verifier needs no inlined copy.
        const slug = decodeURIComponent(path.split("/").pop() || "").toLowerCase();
        const rec = BUILTIN_MAP[slug] || (await getUserChooser(env, slug));
        if (!rec || !Array.isArray(rec.items) || !rec.items.length) {
          return json({ error: "no item list for that slug" }, 404);
        }
        return json({ slug, items: rec.items });
      }

      /* Social preview -------------------------------------------- */

      if (path === "/social.png") {
        // Immutable: the bytes only change when the worker is redeployed,
        // and og:image scrapers cache aggressively anyway.
        return new Response(SOCIAL_PNG, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=31536000, immutable",
            ...CORS,
          },
        });
      }

      /* Verify page ------------------------------------------------- */

      if (path === "/verify") {
        return html(verifyPage(), 200, { "cache-control": "no-store" });
      }

      /* Dice tray --------------------------------------------------- */

      if (path === "/dice") {
        const rawDice = url.searchParams.getAll("d");
        const validDice =
          rawDice.length === 0
            ? [{ min: 1, max: 6 }]
            : rawDice.map(dieFromParam).filter((die) => die !== null);
        const capped = validDice.length > 24;
        const dice = Object.freeze(
          validDice.slice(0, 24).map((die) => Object.freeze({ min: die.min, max: die.max }))
        );
        if (request.method === "GET" && wantsText(request)) {
          const body = url.searchParams.has("roll")
            ? await rollDiceText(dice, capped, origin)
            : renderDiceText(dice, capped, origin, null);
          return text(body, 200, { "cache-control": "no-store" });
        }
        return html(
          page({
            title: "dice tray / random choosers",
            desc: "Roll a shareable tray of dice from one verifiable randomness beacon commit.",
            canonical: "https://random.oddspark.dev/dice/",
            cards: diceCardHtml(dice, capped),
            choosers: [],
            showCreate: false,
            sitekey: env.TURNSTILE_SITE_KEY || "",
          }),
          200,
          { "cache-control": "no-store" }
        );
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
        // Only the number chooser honors ?min=/?max= pre-fill; every other
        // type gets no bounds arg and ignores the params entirely.
        const bounds =
          rec.type === "number"
            ? {
                min: boundFromParam(url.searchParams.get("min"), 1),
                max: boundFromParam(url.searchParams.get("max"), 100),
              }
            : undefined;
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
            cards: cardHtml(rec, counts[slug], bounds),
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
            lede: "Every card is a button. The built-ins roll in your browser; the rest were named by visitors, with lists written once by a model and fixed forever. One new chooser per person per day.",
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
