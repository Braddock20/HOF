# tiktok-scraper Worker (Cloudflare)

A Cloudflare Worker that collects **public** TikTok video and creator-profile
metadata and returns it as JSON or CSV.

It is the edge-hosted half of the project: the Python tool
(`tiktok_scraper/`) does hashtag discovery with a real browser, and this
Worker turns any list of video URLs or creator handles into a clean dataset —
with the exact same column names, so both can be pooled into one CSV.

> **Note on layout:** `wrangler.toml`, `package.json` and `tsconfig.json` live
> at the **repository root**, not in `worker/`. Cloudflare's build system runs
> `npx wrangler deploy` from the repo root, so wrangler must find its config
> there — otherwise it fails with *"Could not detect a directory containing
> static files"*. Only the TypeScript source lives in `worker/src/`.

---

## Quick start

```bash
# from the repository root
npm install
npm run dev            # local dev server on http://127.0.0.1:8787
```

```bash
npm run deploy         # publish to *.workers.dev
```

You need a free Cloudflare account and to be logged in:

```bash
npx wrangler login
```

---

## Deploying from Cloudflare's dashboard

In **Workers & Pages → your Worker → Settings → Builds**, set:

| Field | Value |
| --- | --- |
| Build command | `npm run deploy` |
| Install command | `npm install` |
| Root directory | `/` (repo root) |

If you leave the install command blank, Cloudflare auto-detects the Python
`requirements.txt` in this repo and installs pandas/matplotlib/playwright —
about 90 seconds you do not need. Setting it to `npm install` skips that.

Check the build log for:

```
Total Upload: 21.67 KiB / gzip: 6.24 KiB
```

That means the Worker bundled correctly.

---

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `GET /` | service description and usage |
| `GET /api/health` | liveness probe (returns the colo it ran in) |
| `GET /api/video?url=<video url>` | one video's metadata |
| `GET /api/profile?handle=<handle>` | one creator's public profile |
| `GET /api/scrape?urls=a,b&handles=c,d` | batch, query form |
| `POST /api/scrape` | batch, JSON body |

Every endpoint accepts `?format=json` (default) or `?format=csv`.

### Examples

```bash
# one video
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/video?url=https://www.tiktok.com/@user/video/123"

# one creator: bio, avatar, followers, following, post count
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/profile?handle=bellapoarch"

# batch, as CSV
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/scrape?format=csv&urls=URL1,URL2&handles=bellapoarch"

# batch, as JSON
curl -X POST "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/scrape" \
     -H "Content-Type: application/json" \
     -d '{"urls":["URL1","URL2"],"handles":["bellapoarch","booktok"]}'
```

### Batch parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `delayMs` | 1000 | pause between outgoing requests |
| `concurrency` | 4 | how many requests run in parallel |
| `lang` | `en-US` | `Accept-Language` header |

Maximum **40 items per request** (the free plan allows 50 subrequests and one
TikTok page costs one subrequest).

---

## Protecting the worker

By default the worker is public. To require a key:

```bash
npx wrangler secret put API_KEY
```

Callers then send it in any of these ways:

```bash
-H "X-API-Key: YOUR_KEY"
-H "Authorization: Bearer YOUR_KEY"
"?key=YOUR_KEY"
```

For local testing, copy `.dev.vars.example` to `.dev.vars` and set your own
value — wrangler loads it automatically.

---

## What it collects

**Videos** — video id and URL, creator (handle, nickname, bio, avatar,
followers, following, post count, account likes, verified flag), caption,
hashtags, mentions, sound (title, artist, original flag, duration),
engagement (likes, comments, shares, saves, plays, reposts), publish date and
time, duration, dimensions, thumbnail URL, language, and ad/AI flags.

**Profiles** — handle, nickname, bio, bio link, avatar (three sizes), verified
and private flags, follower / following / post / like counts, account creation
date, and the account's language.

45 columns for videos, 26 for profiles — identical to the Python scraper's
CSV header.

---

## Limits, honestly

- **No hashtag discovery.** Workers cannot run a browser, and TikTok renders
  hashtag listings client-side. Use the Python tool to find videos, then feed
  the URLs here.
- **Subrequest cap.** 40 items per request on the free plan. Batch larger
  collections across several requests.
- **CPU limit.** Parsing a full TikTok page costs some CPU. The `wrangler.toml`
  in this repo sets `cpu_ms = 30000`, which needs a paid plan; on the free
  plan (10 ms) large batches may fail with a CPU time error. Keep batches
  small if you are on the free tier.
- **TikTok rate-limits by IP.** Worker egress IPs are shared, so a burst can
  trip TikTok's bot check. Use `delayMs=1500` or higher for bulk work.
- **Signed URLs expire.** Thumbnail and avatar URLs carry expiry tokens and
  stop working after a few hours. Download them during collection if you need
  the images.

---

## Ethics

Same rules as the Python tool: public data only, no login, no private
accounts, no comment text, no personal data beyond public handles and public
counters. Use a key, keep the sample modest, and publish aggregate analysis
rather than raw data. See the ethics section in the top-level `README.md`.

---

## Layout

```
/
├── wrangler.toml        # Worker config (root - Cloudflare needs it here)
├── package.json         # npm scripts: dev / deploy / typecheck
├── tsconfig.json
├── .dev.vars.example    # copy to .dev.vars for local API-key testing
└── worker/
    ├── src/
    │   ├── index.ts     # router, batch handling, rate limiting, CORS
    │   ├── tiktok.ts    # page parsing + normalisation
    │   └── types.ts     # shared types and column order
    └── README.md
```
