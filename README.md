# random choosers

`random.oddspark.dev` — a shelf of random choosers. Every chooser is a card
with a name, a press button, an inline result, and a press count. Single-file
Cloudflare Worker, no build step. Same conventions as
[oddspark](https://oddspark.dev).

## Built-in choosers

Five choosers ship in the worker and run entirely in the browser — no server
calls, no counters:

| slug | what it does |
|---|---|
| `number` | random integer in [min, max] inclusive; swaps the bounds if min > max, clamps inputs to ±1e12 |
| `color` | random hex color, swatch + click-to-copy hex code |
| `shape` | random polygon/blob on a small canvas (3–9 vertices, radius jitter, stroke or fill, fixed palette) |
| `animal` | picks from a hardcoded 72-item animal list |
| `simpsons-character` | picks from a hardcoded 64-item Simpsons list |

They are defined as a data table in `src/worker.js` (`BUILTINS`), so the
homepage grid and the `/c/:slug` permalinks render them identically.

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

`POST /api/pick/:slug` picks a uniformly random item
(`crypto.getRandomValues`, rejection sampling, repeats allowed) and increments
the press counter in the `Counters` Durable Object. If the record's `listDay`
is not today's UTC date, a list regeneration is kicked off via
`ctx.waitUntil` — the press returns the current item immediately, and on any
generation failure the old list is kept, never blanked.

## Routes

| route | what |
|---|---|
| `GET /` | HTML card grid (built-ins, then KV choosers with counts from one DO `/counts` call, create card last). curl/wget/no-`text/html` gets a `text/plain` rendering |
| `GET /c/:slug` | permalink for one chooser (built-ins too); unknown slug → 404 page, not a redirect. Honors the text sniffing |
| `POST /api/pick/:slug` | `{slug, name, item, count}`; 404 JSON for unknown slugs |
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
20b screens and rejects names containing "blocked"), and Turnstile is bypassed
because `TURNSTILE_SECRET` is unset. Covers builtin integrity, slugify and
collision suffixes, create/reject/rate-limit flows, picks and counters, the
stale-`listDay` background refresh, permalinks, the curl text path, and
`/api/choosers`.
