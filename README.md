# tiktok-scraper

A small, respectful tool for collecting **public TikTok video metadata** so you
can analyse it in a school project.

It collects the facts a video's page already exposes publicly: caption,
hashtags, sound, publish date, duration, and engagement counts (likes,
comments, shares, saves, plays). Output goes to CSV, JSONL or SQLite, and a
companion `analyze.py` turns that data into charts and summary tables.

```
python -m tiktok_scraper --hashtag booktok --limit 100 --out data/
python analyze.py data/tiktok_metadata.csv --out analysis/
```

---

## 1. Install

```bash
git clone <your-repo-url> tiktok-scraper
cd tiktok-scraper

python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m playwright install chromium
```

`playwright install chromium` downloads the browser used for hashtag and
profile collection. You can skip it if you only scrape specific video URLs.

---

## 2. How to use it

### One video

```bash
python -m tiktok_scraper --url "https://www.tiktok.com/@user/video/1234567890"
```

### A list of videos

```bash
python -m tiktok_scraper --urls-file examples/urls.txt --out data/
```

`examples/urls.txt` holds one URL per line; `#` starts a comment.

### A hashtag

```bash
python -m tiktok_scraper --hashtag booktok --limit 100 --out data/
```

### A creator's profile

```bash
python -m tiktok_scraper --user @booktok --limit 100 --out data/
```

### A creator's public profile details

```bash
python -m tiktok_scraper --profile bellapoarch --profile booktok --out data/
```

This is the light-weight path (one HTTP request per creator, no browser) and
it captures the **profile-level** public data:

- display name, bio text, bio link
- profile picture in three sizes (large / medium / thumb)
- follower count, following count, post count, account total likes, friend count
- verified badge, private-account flag
- account creation date, account language

Results are written to a separate `*_profiles.csv` (and the `profiles` table
in SQLite). Non-existent accounts are recorded with `status = failed` rather
than silently dropped.

### Combining sources and formats

```bash
python -m tiktok_scraper \
    --hashtag booktok --hashtag studytok \
    --url "https://www.tiktok.com/@user/video/123" \
    --format all --out data/
```

### Filtering

```bash
python -m tiktok_scraper --hashtag booktok --limit 200 \
    --min-likes 1000 --since 2025-01-01 --until 2025-12-31 --out data/
```

### Useful options

| Option | Default | What it does |
| --- | --- | --- |
| `--limit N` | 60 | max videos per hashtag/profile |
| `--format csv\|jsonl\|sqlite\|all` | `csv` | output format(s) |
| `--out DIR` | `tiktok_data` | output folder |
| `--name STEM` | `tiktok_metadata` | output file name stem |
| `--delay SEC` | 2.0 | minimum pause between requests |
| `--jitter SEC` | 1.5 | random extra pause per request |
| `--scroll-pause SEC` | 4.0 | pause between scrolls in browser mode |
| `--concurrency N` | 4 | parallel fetches in URL mode |
| `--retries N` | 3 | retries per failed request |
| `--resume` | off | skip videos already in the output CSV |
| `--headful` | off | show the browser window while collecting |
| `--quiet` / `--verbose` | — | control logging |

Run `python -m tiktok_scraper --help` for the full list.

### Sources at a glance

| Source | Browser needed | Speed | Reliability |
| --- | --- | --- | --- |
| `--url` / `--urls-file` | no | ~0.5 s each | high |
| `--profile` / `--profiles-file` | no | ~1 s each | high |
| `--hashtag` | yes | ~4 s each | good (rate-limit sensitive) |
| `--user` | yes | ~4 s each | poor — TikTok blocks profile feeds |

---

## 3. How it works

TikTok serves the same metadata payload in two different places, and this tool
uses whichever one works for the job.

**Single video pages** embed their metadata as a JSON blob in the HTML
(`__UNIVERSAL_DATA_FOR_REHYDRATION__`). A plain HTTP request plus a JSON parse
is enough — no browser, ~0.5 s per video, and it works without JavaScript.

**Hashtag and profile listings** are rendered client-side, so the tool starts
a real Chromium through Playwright and *reads the JSON responses the page
already received* (`/api/challenge/item_list/`, `/api/post/item_list/`). It
also harvests the video links from the rendered DOM, because TikTok sometimes
shows more videos in the page than it returns in the list payload; those extra
videos get their full metadata from the reliable HTTP path.

> **Real-world note on profile mode.** Hashtag pages (`/tag/...`) work
> reliably. Creator profile feeds (`/@handle`) are protected more aggressively
> — TikTok frequently answers them with an empty response or a "Something went
> wrong" page, and no amount of retrying fixes it in the same session. When
> that happens the tool says so plainly instead of writing empty rows.
>
> The workaround is the one used above: scrape the creator's *videos* you
> already know the URLs for with `--url`, or collect videos from a hashtag
> they post under. Profile mode still works from time to time, so it is worth
> trying — just don't build a project that depends on it.

```
  hashtag/profile mode                 URL mode
  ┌───────────────────────┐            ┌──────────────────────┐
  │ Chromium (Playwright) │            │  urllib + regex     │
  │  └ reads item_list   │            │  └ parses embedded   │
  │  └ harvests DOM links│            │    JSON blob         │
  └───────────┬───────────┘            └──────────┬───────────┘
              │                                   │
              └──────────► normalise ◄────────────┘
                                │
                    CSV / JSONL / SQLite
```

Both paths produce the same schema, so the dataset is homogeneous no matter
how each video was found.

### Request pacing

TikTok rate-limits by IP. If you fire many browser sessions in quick
succession you will hit a "Something went wrong" page; the tool detects that
and tells you rather than silently returning nothing. If you see it:

- wait a few minutes before retrying,
- raise `--delay` and `--scroll-pause`,
- or switch to `--url` mode, which is far lighter on the server.

---

## 4. Output

### Files

| File | Contents |
| --- | --- |
| `tiktok_metadata.csv` | one row per video, UTF-8, fixed header |
| `tiktok_metadata.jsonl` | same data, one JSON object per line |
| `tiktok_metadata.sqlite3` | same data, table `videos` |
| `tiktok_metadata_profiles.csv` | one row per creator profile (only with `--profile`) |
| `tiktok_metadata_profiles.jsonl` | same, JSON lines |
| `tiktok_metadata_profiles.sqlite3` | same, table `profiles` |

Rows are written as they are collected, so an interrupted run still leaves you
with a usable file.

### Data dictionary

| Field | Type | Description |
| --- | --- | --- |
| `video_id` | str | TikTok's numeric video id |
| `url` | str | canonical video URL |
| `source_url` | str | page the video was discovered on |
| `discovery_mode` | str | `url`, `hashtag` or `user` |
| `author_handle` | str | creator's unique TikTok handle |
| `author_id` | str | creator's numeric id |
| `author_nickname` | str | display name |
| `author_verified` | bool | verification badge |
| `author_followers` | int | follower count |
| `author_following` | int | following count |
| `author_video_count` | int | creator's total post count |
| `author_heart_count` | int | total likes across the account |
| `author_bio` | str | creator's bio text |
| `author_avatar` | str | profile picture URL (signed, expires) |
| `caption` | str | full caption text |
| `hashtags` | str | comma-separated hashtags |
| `hashtag_count` | int | number of hashtags |
| `mentions` | str | comma-separated mentioned handles |
| `sound_id` | str | id of the audio used |
| `sound_title` | str | audio title (e.g. `original sound`) |
| `sound_author` | str | audio's artist |
| `sound_is_original` | bool | creator's own audio |
| `sound_duration` | int | audio length in seconds |
| `likes` | int | digg count |
| `comments` | int | comment count |
| `shares` | int | share count |
| `saves` | int | favourite/collect count |
| `plays` | int | view count |
| `reposts` | int | repost count |
| `create_time` | str | Unix timestamp of publication |
| `create_date` | str | publication date, `YYYY-MM-DD` |
| `create_hour` | int | hour of publication (UTC) |
| `create_weekday` | str | day of publication (UTC) |
| `location_created` | str | country/region flag shown on the video |
| `duration_seconds` | int | video length |
| `width` / `height` | int | pixel dimensions |
| `cover_url` | str | thumbnail URL (signed, expires) |
| `video_language` | str | language TikTok detected |
| `is_ad` | bool | content is a promoted post |
| `is_pinned` | bool | creator pinned it to their profile |
| `is_aigc` | bool | TikTok's AI-generated-content flag |
| `scraped_at` | str | ISO timestamp of collection |
| `status` | str | `ok` or `failed` |
| `status_message` | str | why a row failed |

Empty cells mean TikTok did not expose that value (common for private or
removed posts). Rows with `status = failed` are kept so your method section
can report the true success rate.

### Profile table

`--profile` writes a second, smaller table with one row per creator:

| Field | Type | Description |
| --- | --- | --- |
| `handle` | str | creator's handle |
| `profile_url` | str | profile URL |
| `user_id` / `sec_uid` | str | TikTok's internal ids |
| `nickname` | str | display name |
| `bio` | str | bio text |
| `bio_link` | str | link in the bio |
| `avatar_large` / `avatar_medium` / `avatar_thumb` | str | profile picture, three sizes |
| `verified` | bool | verification badge |
| `is_private` | bool | private account |
| `follower_count` | int | followers |
| `following_count` | int | accounts followed |
| `video_count` | int | total posts |
| `total_likes` | int | likes across all their videos |
| `friend_count` | int | mutual connections |
| `account_created` / `account_created_date` | str | when the account was created |
| `language` | str | account's main language |
| `show_music_tab` | bool | creator has a music tab |
| `has_bio_link` | bool | bio contains a link |
| `scraped_at` | str | ISO timestamp of collection |
| `status` | str | `ok` or `failed` |
| `status_message` | str | why a row failed |

---

## 5. Analysis

```bash
python analyze.py data/tiktok_metadata.csv --out analysis/
```

Produces:

- `engagement_hist.png` — distribution of likes (log-scaled counts)
- `top_hashtags.png` — hashtags ranked by total likes
- `posting_heatmap.png` — publication timing, weekday × hour (UTC)
- `top_creators.png` — creators ranked by engagement
- `duration_vs_likes.png` — video length vs popularity
- `summary_stats.csv`, `top_hashtags.csv` — the numbers behind the charts

Requires `pandas` and `matplotlib` (in `requirements.txt`).

---

## 6. The Cloudflare Worker

`worker/` contains a Cloudflare Worker that does the same collection from the
edge and returns JSON or CSV over HTTP. It is useful when you want to collect
from somewhere other than your laptop, or expose the scraper as a small
service for your project.

```bash
cd worker
npm install
npm run dev        # local server on http://127.0.0.1:8787
npm run deploy     # publishes to *.workers.dev
```

| Endpoint | What it does |
| --- | --- |
| `GET /api/video?url=<video url>` | one video's metadata |
| `GET /api/profile?handle=<handle>` | one creator's public profile |
| `GET /api/scrape?urls=a,b&handles=c,d` | batch (up to 40 items) |
| `POST /api/scrape` | batch with a JSON body |
| `GET /api/health` | liveness probe |

Every endpoint takes `?format=json` (default) or `?format=csv`. The Worker
outputs **exactly the same columns** as the Python tool (45 for videos, 26 for
profiles), so data from both can be pooled into one CSV.

```bash
# collect with Python (finds videos via a hashtag), then enrich via the Worker
python -m tiktok_scraper --hashtag booktok --limit 50 --out data/
curl "https://tiktok-scraper.YOUR-SUBDOMAIN.workers.dev/api/scrape?format=csv&handles=booktok"
```

**What the Worker cannot do:** hashtag discovery. Workers cannot run a
browser, and TikTok renders hashtag listings client-side — so the Python tool
does discovery and the Worker does the fetching and formatting. Also note the
free plan's 10 ms CPU limit is tight for parsing full video pages; the
included `wrangler.toml` sets `cpu_ms = 30000`, which needs a paid plan.

See `worker/README.md` for the full API reference and deployment notes.

---

## 7. Ethics, legality and good practice

Please read this before you submit anything built with this tool.

**What this tool does**

- Collects only data that a video's public page shows to any logged-out visitor.
- Collects only public *profile* data too: bio, profile picture, follower /
  following / post counts, account age. Nothing private.
- Stores no personal data beyond public creator handles and counts.
- Paces itself (default: one request every 2–3.5 s) and stops early when
  TikTok starts rate-limiting.
- Records exactly what it collected, when, and from where.

**What this tool deliberately does not do**

- No logging in, no cookie theft, no bypassing age gates or region blocks.
- No forging API signatures, no proxy rotation, no identity spoofing to
  look like a human.
- No collection of comments, follower lists, private accounts or direct
  messages.
- No bulk crawling of the whole platform.

**Things you should know about TikTok's rules**

- TikTok's `robots.txt` allows `/tag` and `/discover` for general crawlers and
  does not disallow video pages, but it *does* disallow `/search` and a list
  of named AI crawler agents (`GPTBot`, `ClaudeBot`, `Bytespider` and
  others). If your project uses an AI assistant as part of its workflow, you
  should note this in your write-up.
- Scraping can still breach TikTok's Terms of Service, which can lead to
  accounts being blocked. The practical guidance for any academic project:
  **use a personal account, keep the sample small, work slowly, and do not
  redistribute the raw data.**
- For anything that might be published, reused or commercially sensitive, use
  the official **TikTok Research API** (academic access, approved
  institutions) or the **Display API** instead. That is the fully compliant
  route, and many schools can apply for it.

**Practical rules for a school project**

1. State in your method section: what you collected, how many videos, on what
   date, from which hashtags.
2. Keep the sample modest (a few hundred videos is plenty for a school
   project) and report the collection window.
3. Only publish **aggregate analysis**. If you quote a caption, keep the
   creator's handle to the one shown publicly and do not publish full
   follower lists.
4. Say plainly that engagement counts are a snapshot: they change every hour,
   so give the date and time of collection.
5. If your teacher asks about ethics, this README is a reasonable starting
   point to discuss — copy the relevant points into your write-up.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Something went wrong" / bot-check page | TikTok rate-limited your IP | wait a few minutes, raise `--delay` and `--scroll-pause`, use `--url` mode |
| 0 videos from a **profile** | TikTok blocks profile feeds aggressively (most common cause) | retry later; or collect the creator's videos by URL, or via a hashtag they post under |
| 0 videos from a hashtag | same as above, or the tag has no videos | retry later; try a different tag |
| `videos written: 0` but no errors | every URL failed | check the URLs, and that `tiktok.com` is reachable |
| `status = failed` rows | video was deleted, private, or region-blocked | expected; report the success rate in your method |
| `status = failed` on a profile | no such account, or it was blocked/suspended | check the handle; private accounts still return public stats |
| `ModuleNotFoundError: playwright` | browser deps missing | `pip install playwright && python -m playwright install chromium` |
| Worker returns `CPU time exceeded` | free plan's 10 ms CPU cap | use fewer items per batch, or switch to the paid plan (`cpu_ms = 30000`) |
| Worker returns 401 | `API_KEY` secret is set | send it as `X-API-Key`, `Authorization: Bearer`, or `?key=` |
| Chart is empty | all rows failed | run the scraper again and check the CSV first |

---

## 9. Project layout

```
tiktok-scraper/
├── tiktok_scraper/
│   ├── __init__.py
│   ├── __main__.py      # python -m tiktok_scraper
│   ├── cli.py           # argument parsing + orchestration
│   ├── fetchers.py      # HTTP fetcher + Playwright session
│   ├── extract.py       # JSON -> flat records
│   ├── models.py        # record schema
│   └── storage.py       # CSV / JSONL / SQLite writers
├── analyze.py           # charts + summary statistics
├── worker/              # Cloudflare Worker (edge-hosted API)
│   ├── src/index.ts     # router, batching, rate limiting
│   ├── src/tiktok.ts    # page parsing + normalisation
│   └── wrangler.toml
├── examples/urls.txt
├── requirements.txt
├── METHODOLOGY_TEMPLATE.md
└── README.md
```

---

## 10. License

MIT — use it freely for your project. TikTok content belongs to its creators;
collect it for analysis, don't republish it.
