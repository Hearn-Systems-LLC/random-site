# random choosers

`random.oddspark.dev` — a shelf of random choosers. Every chooser is a card
with a name, a press button, an inline result, and a press count. Single-file
Cloudflare Worker, no build step. Same conventions as
[oddspark](https://oddspark.dev).

Every pick is **verifiable**: it commits to a [drand](https://drand.love)
quicknet round this gateway path has not published yet plus a one-press
nonce, waits for publication (typically ~0–3s), and derives the result
deterministically. The badge under each result links to `/verify`, where
anyone can recompute the pick. Details below.

## Built-in choosers

Six choosers ship in the worker. Five run their picks in the browser — no
server calls, no counters; the sixth, `random`, calls the server when it lands
on a user chooser:

| slug | what it does |
|---|---|
| `number` | random integer in [min, max] inclusive; swaps the bounds if min > max, clamps inputs to ±1e12 |
| `color` | random hex color, swatch + click-to-copy hex code |
| `shape` | random polygon/blob on a small canvas (3–9 vertices, radius jitter, stroke or fill, fixed palette) |
| `animal` | picks from a hardcoded 72-item animal list |
| `simpsons-character` | picks from a hardcoded 64-item Simpsons list |
| `random` | picks one of the other choosers, then a result from it; pool configurable per visitor |

They are defined as a data table in `src/worker.js` (`BUILTINS`), so the
homepage grid and the `/c/:slug` permalinks render them identically.

The sixth built-in, `random`, is a meta chooser: it picks one of the others and
delegates, so the result renders in whatever form that chooser produces — a
swatch, a canvas, or a server pick. Which choosers it may land on is set per
visitor with two group toggles plus a per-chooser `customize` list, stored in
`localStorage` under `rc_pool`.

Preferences are stored as *exclusions* (`{builtins, users, off: [slug]}`), not
inclusions, so choosers created after a visitor sets preferences are in the pool
by default rather than silently absent.

Landing on a user chooser calls the same `POST /api/pick/:slug` as a direct
press, so indirect presses count. `random` itself has no press counter, matching
the other built-ins.

## Verifiable randomness

Picks used to come straight from `crypto.getRandomValues` — genuine, but
unprovable. Now every pick (browser card presses and `POST /api/pick/:slug`
alike) is a commit-reveal against the drand quicknet beacon
(`https://drand.cloudflare.com`, chain `52db9ba7…c84e971`, 3s period):

1. **Commit** — on press, mint an 8-byte hex nonce and probe forward to the
   commit round: `GET …/public/latest` to seed, then probe the next 10
   rounds **in parallel** with cache-busted GETs (`?p=<n>`) and commit to
   the lowest 404 — the first round this gateway path will not serve yet.
   Parallel because some backends hold a frontier request for a full period
   (~3s) until the round is produced; a sequential walk chases the moving
   frontier. The probe exists because the gateway's publication horizon is
   inconsistent across anycast backends (measured: +1 to +14 rounds ahead
   of the genesis schedule), and 404s get cached ~27s, so no computed round
   is reliably unpublished at commit — and an un-busted poll would poison
   its own later polls. If all 10 probes come back served, the commit is
   the last probed round + 1 and the poll cap is the backstop. Documented
   caveat: a *different* backend may already serve the committed round; the
   guarantee is "unpublished on the path this press is using".
2. **Wait** — poll the committed round (cache-busted, ~1s interval, ~18s
   cap) until the beacon publishes it; a few seconds typically, occasionally
   longer on a backend flip. The button is disabled and the card shows
   "awaiting beacon round N…".
3. **Derive** — the item is deterministic:
   `seed = sha256hex(randomness + ":" + nonce + ":" + slug + ":" + drawIx)`,
   walked as eight uint32 words with rejection sampling (rehash with an
   appended counter on exhaustion). The meta chooser spends draw 0 picking the
   chooser, so its item draws start at 1; color consumes six draws (one per
   hex digit), shape three (sides, palette, filled), number and list one.

The derivation is one self-contained function injected into the homepage and
the `/verify` page verbatim (the same `.toString()` pattern as `computePool`),
so browser, server, and verifier run byte-identical logic. Each result gets a
badge: **verified · round N**, linking to a prefilled
`/verify?slug=&round=&nonce=&item=` (plus `&via=` when the meta chooser
delegated, `&min=&max=` for non-default number bounds). `/verify` fetches the
round from drand in the visitor's own browser and recomputes the item;
visitor-made lists are rewritten daily, so their picks only recompute
same-day. API responses carry the same `proof: {round, nonce}`.

If the beacon is unreachable (or a number span exceeds 2³², which 32-bit hash
words can't draw from), the press falls back to a local
`crypto.getRandomValues` pick, badged **unverified**, and API responses carry
`proof: null`. A broken beacon never breaks a card.

## User-created choosers

The last card on the homepage is a creation form: a name (max 60 chars), a
Cloudflare Turnstile widget, submit. `POST /api/create` then runs, in order:

1. **Signed cookie** — `rc_uid` is `<16 random bytes hex>.<HMAC-SHA256 hex>`
   keyed on `COOKIE_SECRET` (WebCrypto HMAC). HttpOnly, Secure, SameSite=Lax,
   one-year Max-Age, issued on any HTML page view when absent or invalid.
2. **Turnstile** — verified against siteverify with `TURNSTILE_SECRET` + the
   token + client IP. If `TURNSTILE_SECRET` is unset, verification is skipped
   entirely (documented dev/test bypass).
3. **Rate limit** — one creation per UTC day per cookie, tracked as
   `rl:<UTC-date>:<sha256(cookie)>` in KV with a 2-day TTL. The key is written
   only *after* a creation succeeds; failures never consume the day's slot.
4. **AI screening** — a small static regex blocklist first, then
   `@cf/openai/gpt-oss-20b` classifies the name as
   `{"allow": true|false, "reason": "..."}`. Sexual, hateful, harassing,
   illegal, and PII-soliciting names are rejected with 403 and never stored.
5. **AI list generation** — `@cf/openai/gpt-oss-120b` is prompted for a raw
   JSON array of 64 distinct short items. The response is sanitized (trim,
   drop empties, dedupe case-insensitively, cap 48 chars/item); fewer than 8
   valid items fails the creation with 502.
6. **Store** — `c:<slug>` in KV:
   `{slug, name, kind: "user", items, created, listDay}`. Slugs are
   lowercased, non-alphanumerics collapsed to `-`, max 40 chars; collisions
   (against KV and built-in slugs) get a `-<4 hex>` suffix.

Model response shapes are normalized by one helper (`aiText`): the gpt-oss
models only populate OpenAI-style `choices[0].message.content`, while
llama-style models return `response` as a string *or* as an already-parsed
object. Both gpt-oss models are reasoning models, so calls use
`max_tokens: 2048` — smaller caps get eaten by the chain of thought and
truncate the JSON.

### Daily refresh

`POST /api/pick/:slug` derives an item from the committed beacon round (see
above; falls back to `crypto.getRandomValues` with `proof: null` when the
beacon is down, repeats allowed either way) and increments the press counter
in the `Counters` Durable Object. If the record's `listDay` is not today's UTC
date, a list regeneration is kicked off via `ctx.waitUntil` — the press returns
the current item immediately, and on any generation failure the old list is
kept, never blanked.

## Routes

| route | what |
|---|---|
| `GET /` | HTML card grid (built-ins, then KV choosers with counts from one DO `/counts` call, create card last). curl/wget/no-`text/html` gets a `text/plain` rendering |
| `GET /c/:slug` | permalink for one chooser (built-ins too); unknown slug → 404 page, not a redirect. Honors the text sniffing |
| `GET /verify` | recomputation page: prefilled from `?slug=&round=&nonce=&item=` (plus optional `&via=`, `&min=&max=`); fetches the round from drand in the visitor's browser and reports match/mismatch |
| `POST /api/pick/:slug` | `{slug, name, item, count, proof}`; `proof` is `{round, nonce}` for beacon-derived picks, `null` on fallback. 404 JSON for unknown slugs |
| `GET /api/items/:slug` | `{slug, items}` — the list a `/verify` recomputation draws from; 404 for unknown slugs and non-list built-ins |
| `POST /api/create` | `{slug, name}` or a JSON error (400 / 403 / 429 / 502) |
| `GET /api/choosers` | `[{slug, name, kind}]` for everything; built-ins marked `"builtin"` |
| `OPTIONS *` | permissive CORS |

The `Counters` Durable Object is a plain exported class (no
`cloudflare:workers` import, so `test.mjs` can run under plain Node), a single
`global` instance, SQLite-backed. It answers `POST /hit` (`{slug}` →
`{slug, count}`), `GET /?slug=<slug>`, and `POST /counts` (`{slugs:[...]}` →
`{counts}`). Counter failures degrade silently — picks and pages still render.

## Deploy

```sh
npm install
npx wrangler kv namespace create CHOOSERS   # paste the id into wrangler.toml
npx wrangler secret put COOKIE_SECRET
npx wrangler secret put TURNSTILE_SECRET    # optional; unset = turnstile bypass
# set TURNSTILE_SITE_KEY in wrangler.toml [vars] to match
npm run deploy
```

The route `random.oddspark.dev` attaches as a custom domain once the zone is
active. The `COUNTERS` Durable Object requires the Workers Paid plan.

## Test

```sh
node test.mjs
```

No dependencies, no network: KV is a Map, the Durable Object is a stub
honoring the worker's string-URL + init calling convention, the AI binding
switches on model name (120b returns a 10-item JSON array in gpt-oss shape,
20b screens and rejects names containing "blocked"), `globalThis.fetch` is
stubbed to answer only drand beacon URLs (deterministic randomness per round;
anything else throws), and Turnstile is bypassed because `TURNSTILE_SECRET` is
unset. Covers builtin integrity, slugify and collision suffixes,
create/reject/rate-limit flows, picks and counters, the stale-`listDay`
background refresh, permalinks, the curl text path, `/api/choosers`, the
beacon round math, derivation vectors and uniformity, client/server
derivation equivalence via the shipped script, proof fields on every
`/api/pick` shape, beacon-down fallback, the poll loop, and the `/verify`
page.
