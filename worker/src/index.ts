/**
 * tiktok-scraper Worker
 * ---------------------
 * Collects public TikTok video and profile metadata from the edge.
 *
 * Endpoints
 *   GET  /                      service description + usage
 *   GET  /api/health            liveness probe
 *   GET  /api/video?url=...     one video's metadata
 *   GET  /api/profile?handle=.. one creator's public profile
 *   GET  /api/scrape?urls=a,b&handles=c,d   batch (query form)
 *   POST /api/scrape            batch {"urls": [...], "handles": [...]}
 *
 * Every endpoint accepts `?format=json` (default) or `?format=csv`.
 *
 * Scope note: Workers cannot run a browser, so this service handles video
 * URLs and creator profiles. Hashtag *discovery* needs a real browser and
 * lives in the Python tool (`tiktok-scraper/`), which can hand this Worker
 * the URLs it finds.
 */

import {
  extractProfile,
  extractVideoItem,
  failedProfile,
  failedVideo,
  fetchPage,
  normalizeProfile,
  normalizeVideo,
} from "./tiktok";
import { PROFILE_FIELDS, ProfileRecord, VIDEO_FIELDS, VideoRecord } from "./types";

interface Env {
  /** Optional shared secret. When set, requests must send it. */
  API_KEY?: string;
}

const VERSION = "1.0.0";

/** Free plan allows 50 subrequests; stay well inside that. */
const MAX_ITEMS = 40;
const DEFAULT_DELAY_MS = 1000;
const DEFAULT_CONCURRENCY = 4;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

function csv(rows: Record<string, unknown>[], fields: string[]): Response {
  const escape = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [fields.join(",")];
  for (const row of rows) {
    lines.push(fields.map((field) => escape(row[field])).join(","));
  }
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="tiktok_metadata.csv"',
      ...CORS_HEADERS,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collect a video's metadata. */
async function scrapeVideo(
  url: string,
  language: string,
): Promise<VideoRecord> {
  const scrapedAt = new Date().toISOString();
  try {
    const html = await fetchPage(url, language);
    const { item, message } = extractVideoItem(html);
    if (!item) return failedVideo(url, message || "unavailable", scrapedAt);
    return normalizeVideo(item, url, "url", scrapedAt);
  } catch (error) {
    return failedVideo(url, String(error), scrapedAt);
  }
}

/** Collect a creator's public profile details. */
async function scrapeProfile(
  handle: string,
  language: string,
): Promise<ProfileRecord> {
  const scrapedAt = new Date().toISOString();
  const clean = String(handle || "").replace(/^@/, "").trim();
  const url = `https://www.tiktok.com/@${encodeURIComponent(clean)}`;
  try {
    const html = await fetchPage(url, language);
    const { user, stats, message } = extractProfile(html, clean);
    if (!user) return failedProfile(clean, message || "unavailable", scrapedAt);
    return normalizeProfile(user, stats, clean, url, scrapedAt);
  } catch (error) {
    return failedProfile(clean, String(error), scrapedAt);
  }
}

/**
 * Run tasks with a bounded concurrency and a pause between request starts,
 * so the worker behaves politely towards TikTok.
 */
async function runPool<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  delayMs: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  let lastStart = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= tasks.length) return;
      const wait = delayMs - (Date.now() - lastStart);
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker),
  );
  return results;
}

function splitList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const USAGE = {
  name: "tiktok-scraper worker",
  version: VERSION,
  description:
    "Collects public TikTok video and creator-profile metadata. Public data only.",
  endpoints: {
    "GET /api/health": "liveness probe",
    "GET /api/video?url=<video url>": "one video's metadata",
    "GET /api/profile?handle=<handle>": "one creator's profile",
    "GET /api/scrape?urls=<a,b>&handles=<c,d>": "batch",
    "POST /api/scrape": 'batch with body {"urls": [], "handles": []}',
  },
  parameters: {
    format: "json (default) or csv",
    delayMs: `pause between requests, default ${DEFAULT_DELAY_MS}`,
    concurrency: `parallel requests, default ${DEFAULT_CONCURRENCY}`,
    lang: "Accept-Language header, default en-US",
  },
  limits: {
    max_items_per_request: MAX_ITEMS,
    note:
      "Hashtag discovery needs a browser and is not available on Workers - " +
      "use the Python tool for that, then pass URLs here.",
  },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Optional API key gate.
    if (env.API_KEY) {
      const provided =
        request.headers.get("X-API-Key") ||
        request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
        url.searchParams.get("key");
      if (provided !== env.API_KEY) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    const language = url.searchParams.get("lang") || "en-US";
    const format = (url.searchParams.get("format") || "json").toLowerCase();

    // ---- health & usage --------------------------------------------
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        version: VERSION,
        time: new Date().toISOString(),
        colo: (ctx as any)?.cf?.colo ?? null,
        country: (ctx as any)?.cf?.country ?? null,
      });
    }

    if (url.pathname === "/" || url.pathname === "/api") {
      return json(USAGE);
    }

    // ---- single video ------------------------------------------------
    if (url.pathname === "/api/video") {
      const target = url.searchParams.get("url");
      if (!target) return json({ error: "missing ?url=" }, 400);
      const record = await scrapeVideo(target, language);
      if (format === "csv") {
        return csv([record as unknown as Record<string, unknown>], VIDEO_FIELDS as string[]);
      }
      return json(record);
    }

    // ---- single profile ----------------------------------------------
    if (url.pathname === "/api/profile") {
      const handle = url.searchParams.get("handle") || url.searchParams.get("user");
      if (!handle) return json({ error: "missing ?handle=" }, 400);
      const record = await scrapeProfile(handle, language);
      if (format === "csv") {
        return csv([record as unknown as Record<string, unknown>], PROFILE_FIELDS as string[]);
      }
      return json(record);
    }

    // ---- batch --------------------------------------------------------
    if (url.pathname === "/api/scrape") {
      let urls: string[] = splitList(url.searchParams.get("urls"));
      let handles: string[] = splitList(url.searchParams.get("handles"));

      if (request.method === "POST") {
        try {
          const body = (await request.json()) as {
            urls?: unknown;
            handles?: unknown;
          } | null;
          if (body && Array.isArray(body.urls)) urls = body.urls.map(String);
          if (body && Array.isArray(body.handles)) handles = body.handles.map(String);
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
      }

      const total = urls.length + handles.length;
      if (total === 0) {
        return json({ error: "provide urls and/or handles" }, 400);
      }
      if (total > MAX_ITEMS) {
        return json(
          {
            error: `too many items: ${total} (max ${MAX_ITEMS} per request)`,
          },
          400,
        );
      }

      const delayMs = Number(url.searchParams.get("delayMs")) || DEFAULT_DELAY_MS;
      const concurrency = Number(url.searchParams.get("concurrency")) || DEFAULT_CONCURRENCY;

      const videoTasks = urls.map((target) => () => scrapeVideo(target, language));
      const profileTasks = handles.map((handle) => () => scrapeProfile(handle, language));

      const [videos, profiles] = await Promise.all([
        runPool(videoTasks, concurrency, delayMs),
        runPool(profileTasks, concurrency, delayMs),
      ]);

      const okVideos = videos.filter((v) => v.status === "ok").length;
      const okProfiles = profiles.filter((p) => p.status === "ok").length;

      if (format === "csv") {
        if (profiles.length && !urls.length) {
          return csv(
            profiles as unknown as Record<string, unknown>[],
            PROFILE_FIELDS as string[],
          );
        }
        return csv(videos as unknown as Record<string, unknown>[], VIDEO_FIELDS as string[]);
      }

      return json({
        videos,
        profiles,
        meta: {
          requested: total,
          video_count: videos.length,
          profile_count: profiles.length,
          ok: okVideos + okProfiles,
          failed: total - okVideos - okProfiles,
          scraped_at: new Date().toISOString(),
          colo: (ctx as any)?.cf?.colo ?? null,
        },
      });
    }

    return json({ error: "not found", endpoints: Object.keys(USAGE.endpoints) }, 404);
  },
};
