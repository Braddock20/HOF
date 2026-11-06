/**
 * TikTok page parsing for the Worker.
 *
 * TikTok embeds its metadata as a JSON blob in the page HTML
 * (`__UNIVERSAL_DATA_FOR_REHYDRATION__`), so a single `fetch` plus a
 * `JSON.parse` gives us everything we need. No browser required - which
 * matters on Workers, where Chromium is not available.
 */

import { ProfileRecord, VideoRecord } from "./types";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REHYDRATION_RE =
  /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/;

const FRONTITY_RE =
  /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/;

const HASHTAG_RE = /#([\wÀ-ɏ]+)/g;
const MENTION_RE = /@([\w.\-]+)/g;

const MULTIPLIERS: Record<string, number> = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};

/** Coerce a TikTok stat into a number, understanding K/M/B suffixes. */
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;

  let text = String(value).trim().replace(/,/g, "");
  if (!text) return null;

  let multiplier = 1;
  const last = text.slice(-1).toUpperCase();
  if (last in MULTIPLIERS) {
    multiplier = MULTIPLIERS[last];
    text = text.slice(0, -1).trim();
  }
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? Math.round(parsed * multiplier) : null;
}

/** Pull the `__DEFAULT_SCOPE__` object out of a TikTok HTML page. */
export function parseRehydration(html: string): any | null {
  const match = REHYDRATION_RE.exec(html);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    const scope = payload?.__DEFAULT_SCOPE__;
    return scope && typeof scope === "object" ? scope : null;
  } catch {
    return null;
  }
}

/** Extract the raw aweme object from a video page. */
export function extractVideoItem(html: string): { item: any; message: string } {
  const scope = parseRehydration(html);
  if (!scope) return { item: null, message: "no_rehydration_json" };

  const detail = scope["webapp.video-detail"] || {};
  const statusCode = detail.statusCode;
  const statusMsg = detail.statusMsg || "";
  const itemStruct = detail?.itemInfo?.itemStruct;

  if (!itemStruct || typeof itemStruct !== "object") {
    if (statusCode) {
      return { item: null, message: `unavailable (statusCode=${statusCode} ${statusMsg})`.trim() };
    }
    return { item: null, message: "item_struct_missing" };
  }
  if (statusCode !== 0 && statusCode !== undefined && statusCode !== null) {
    return {
      item: null,
      message: `unavailable (statusCode=${statusCode} ${statusMsg})`.trim(),
    };
  }
  return { item: itemStruct, message: "" };
}

/** Extract the raw profile object from a creator page. */
export function extractProfile(
  html: string,
  handle: string,
): { user: any; stats: any; message: string } {
  const scope = parseRehydration(html);
  if (!scope) return { user: null, stats: null, message: "no_rehydration_json" };

  const detail = scope["webapp.user-detail"] || {};
  const statusCode = detail.statusCode;
  const statusMsg = detail.statusMsg || "";
  const userInfo = detail.userInfo || {};
  const user = userInfo.user;
  const stats = userInfo.stats || {};

  if (!user || typeof user !== "object") {
    if (statusCode) {
      return {
        user: null,
        stats: null,
        message: `unavailable (statusCode=${statusCode} ${statusMsg})`.trim(),
      };
    }
    return { user: null, stats: null, message: "profile_data_missing" };
  }
  return { user, stats, message: "" };
}

/** Hashtags and mentions, preferring TikTok's own annotation. */
function textParts(item: any): { hashtags: string[]; mentions: string[] } {
  const hashtags: string[] = [];
  const mentions: string[] = [];

  for (const extra of item.textExtra || []) {
    if (!extra || typeof extra !== "object") continue;
    if (extra.type === 1 && extra.hashtagName) {
      const name = String(extra.hashtagName).trim();
      if (name && !hashtags.includes(name)) hashtags.push(name);
    } else if (extra.type === 2 && (extra.uniqueId || extra.userId)) {
      const id = String(extra.uniqueId || extra.userId).trim();
      if (id && !mentions.includes(id)) mentions.push(id);
    }
  }

  const caption = String(item.desc || "");
  if (!hashtags.length) {
    // Capture group 1 excludes the leading "#", matching the Python scraper.
    for (const match of caption.matchAll(HASHTAG_RE)) {
      const tag = match[1];
      if (tag && tag.toLowerCase() !== "fyp" && !hashtags.includes(tag)) {
        hashtags.push(tag);
      }
    }
  }
  if (!mentions.length) {
    // Capture group 1 excludes the leading "@".
    for (const match of caption.matchAll(MENTION_RE)) {
      const mention = match[1];
      if (mention && !mentions.includes(mention)) mentions.push(mention);
    }
  }
  return { hashtags, mentions };
}

/** Engagement numbers, preferring the exact `statsV2` values. */
function videoStats(item: any): Record<string, number | null> {
  const v2 = item.statsV2 || {};
  const base = item.stats || {};
  const pick = (name: string): number | null =>
    parseNumber(v2[name] !== undefined ? v2[name] : base[name]);

  return {
    likes: pick("diggCount"),
    comments: pick("commentCount"),
    shares: pick("shareCount"),
    saves: pick("collectCount"),
    plays: pick("playCount"),
    reposts: pick("repostCount"),
  };
}

/** Creator reach numbers, available on every video record. */
function authorStats(item: any) {
  const stats = item.authorStats || {};
  const v2 = item.authorStatsV2 || {};
  const pick = (name: string): number | null =>
    parseNumber(stats[name] !== undefined ? stats[name] : v2[name]);

  return {
    followers: pick("followerCount"),
    following: pick("followingCount"),
    videoCount: pick("videoCount"),
    hearts: pick("heart"),
  };
}

function isoDate(timestamp: number | null): { iso: string; date: string; hour: string; weekday: string } {
  if (!timestamp) return { iso: "", date: "", hour: "", weekday: "" };
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return { iso: "", date: "", hour: "", weekday: "" };
  const days = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];
  return {
    iso: date.toISOString(),
    date: date.toISOString().slice(0, 10),
    hour: String(date.getUTCHours()),
    weekday: days[date.getUTCDay()],
  };
}

/** Turn a raw TikTok aweme object into a flat record. */
export function normalizeVideo(
  item: any,
  sourceUrl: string,
  discoveryMode: string,
  scrapedAt: string,
): VideoRecord {
  const author = item.author || {};
  const music = item.music || {};
  const video = item.video || {};
  const videoId = String(item.id || item.aweme_id || "");
  const handle = String(author.uniqueId || "");
  const caption = String(item.desc || "");
  const { hashtags, mentions } = textParts(item);
  const stats = videoStats(item);
  const creator = authorStats(item);
  const when = isoDate(parseNumber(item.createTime));

  // Challenges carry the "official" hashtag for a video.
  for (const challenge of item.challenges || []) {
    const title = challenge?.title ? String(challenge.title) : "";
    if (title && !hashtags.some((h) => h.toLowerCase() === title.toLowerCase())) {
      hashtags.push(title);
    }
  }

  const num = (value: number | null): number | string => (value === null ? "" : value);

  return {
    video_id: videoId,
    url: handle
      ? `https://www.tiktok.com/@${handle}/video/${videoId}`
      : `https://www.tiktok.com/video/${videoId}`,
    source_url: sourceUrl,
    discovery_mode: discoveryMode,
    author_handle: handle,
    author_id: String(author.id || ""),
    author_nickname: String(author.nickname || ""),
    author_verified: author.verified ? "True" : "False",
    author_followers: num(creator.followers),
    author_following: num(creator.following),
    author_video_count: num(creator.videoCount),
    author_heart_count: num(creator.hearts),
    author_bio: String(author.signature || ""),
    author_avatar: String(author.avatarLarger || author.avatarMedium || ""),
    caption,
    hashtags: hashtags.join(","),
    hashtag_count: hashtags.length,
    mentions: mentions.join(","),
    sound_id: String(music.id || ""),
    sound_title: String(music.title || ""),
    sound_author: String(music.authorName || music.author || ""),
    sound_is_original: music.original ? "True" : "False",
    sound_duration: num(parseNumber(music.duration)),
    likes: num(stats.likes),
    comments: num(stats.comments),
    shares: num(stats.shares),
    saves: num(stats.saves),
    plays: num(stats.plays),
    reposts: num(stats.reposts),
    create_time: item.createTime ? String(item.createTime) : "",
    create_date: when.date,
    create_hour: when.hour,
    create_weekday: when.weekday,
    location_created: String(item.locationCreated || ""),
    duration_seconds: num(parseNumber(video.duration)),
    width: num(parseNumber(video.width)),
    height: num(parseNumber(video.height)),
    cover_url: String(video.cover || video.originCover || video.dynamicCover || ""),
    video_language: String(item.textLanguage || ""),
    is_ad: item.isAd ? "True" : "False",
    is_pinned: item.isPinnedItem ? "True" : "False",
    is_aigc: item.IsAigc ? "True" : "False",
    scraped_at: scrapedAt,
    status: "ok",
    status_message: "",
  };
}

/** Turn a raw TikTok profile object into a flat record. */
export function normalizeProfile(
  user: any,
  stats: any,
  handle: string,
  sourceUrl: string,
  scrapedAt: string,
): ProfileRecord {
  const uniqueId = String(user.uniqueId || handle.replace(/^@/, ""));
  const profileUrl = `https://www.tiktok.com/@${uniqueId}`;

  let totalLikes = parseNumber(stats.heart) ?? 0;
  if (totalLikes <= 0) totalLikes = parseNumber(stats.heartCount) ?? 0;

  let bioLink = "";
  if (user.bioLink && typeof user.bioLink === "object") {
    bioLink = String(user.bioLink.link || "");
  } else if (typeof user.bioLink === "string") {
    bioLink = user.bioLink;
  }

  const createdTs = parseNumber(user.createTime);
  const when = isoDate(createdTs);

  const num = (value: number | null): number | string => (value === null ? "" : value);

  return {
    handle: uniqueId,
    profile_url: profileUrl,
    source_url: sourceUrl || profileUrl,
    user_id: String(user.id || ""),
    sec_uid: String(user.secUid || ""),
    nickname: String(user.nickname || ""),
    bio: String(user.signature || ""),
    bio_link: bioLink,
    avatar_large: String(user.avatarLarger || ""),
    avatar_medium: String(user.avatarMedium || ""),
    avatar_thumb: String(user.avatarThumb || ""),
    verified: user.verified ? "True" : "False",
    is_private: user.privateAccount ? "True" : "False",
    follower_count: num(parseNumber(stats.followerCount)),
    following_count: num(parseNumber(stats.followingCount)),
    video_count: num(parseNumber(stats.videoCount)),
    total_likes: totalLikes,
    friend_count: num(parseNumber(stats.friendCount)),
    account_created: when.iso,
    account_created_date: when.date,
    language: String(user.language || ""),
    show_music_tab: user.profileTab?.showMusicTab ? "True" : "False",
    has_bio_link: bioLink ? "True" : "False",
    scraped_at: scrapedAt,
    status: "ok",
    status_message: "",
  };
}

/** A failed video row, so callers can report a true success rate. */
export function failedVideo(
  url: string,
  reason: string,
  scrapedAt: string,
): VideoRecord {
  const match = /\/video\/(\d+)/.exec(url || "");
  return {
    video_id: match ? match[1] : "",
    url,
    source_url: url,
    discovery_mode: "url",
    author_handle: "",
    author_id: "",
    author_nickname: "",
    author_verified: "",
    author_followers: "",
    author_following: "",
    author_video_count: "",
    author_heart_count: "",
    author_bio: "",
    author_avatar: "",
    caption: "",
    hashtags: "",
    hashtag_count: "",
    mentions: "",
    sound_id: "",
    sound_title: "",
    sound_author: "",
    sound_is_original: "",
    sound_duration: "",
    likes: "",
    comments: "",
    shares: "",
    saves: "",
    plays: "",
    reposts: "",
    create_time: "",
    create_date: "",
    create_hour: "",
    create_weekday: "",
    location_created: "",
    duration_seconds: "",
    width: "",
    height: "",
    cover_url: "",
    video_language: "",
    is_ad: "",
    is_pinned: "",
    is_aigc: "",
    scraped_at: scrapedAt,
    status: "failed",
    status_message: reason,
  };
}

/** A failed profile row. */
export function failedProfile(
  handle: string,
  reason: string,
  scrapedAt: string,
): ProfileRecord {
  const clean = String(handle || "").replace(/^@/, "");
  return {
    handle: clean,
    profile_url: clean ? `https://www.tiktok.com/@${clean}` : "",
    source_url: clean ? `https://www.tiktok.com/@${clean}` : "",
    user_id: "",
    sec_uid: "",
    nickname: "",
    bio: "",
    bio_link: "",
    avatar_large: "",
    avatar_medium: "",
    avatar_thumb: "",
    verified: "",
    is_private: "",
    follower_count: "",
    following_count: "",
    video_count: "",
    total_likes: "",
    friend_count: "",
    account_created: "",
    account_created_date: "",
    language: "",
    show_music_tab: "",
    has_bio_link: "",
    scraped_at: scrapedAt,
    status: "failed",
    status_message: reason,
  };
}

/** Fetch a TikTok page with browser-like headers. */
export async function fetchPage(url: string, language = "en-US"): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": `${language},en;q=0.9`,
      Referer: "https://www.tiktok.com/",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

/**
 * Parse the `__FRONTITY_CONNECT_STATE__` blob used by TikTok's public embed
 * pages. The embed page renders a creator's recent posts server-side, which
 * is the only reliable way to list a profile's posts without a browser or a
 * signed API request.
 */
export function parseFrontity(html: string): any | null {
  const match = FRONTITY_RE.exec(html);
  if (!match) return null;
  try {
    const payload = JSON.parse(match[1]);
    const data = payload?.source?.data;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** Pull `{ userInfo, videos }` out of an embed page (videos are newest-first). */
export function embedProfile(
  html: string,
  handle: string,
): { userInfo: any; videos: any[] } {
  const data = parseFrontity(html);
  if (!data) return { userInfo: {}, videos: [] };
  const key = `/embed/@${handle.replace(/^@/, "")}`;
  const profile = data[key];
  if (!profile || typeof profile !== "object") return { userInfo: {}, videos: [] };
  const videos = (profile.videoList || []).filter(
    (v: any) => v && typeof v === "object" && v.id,
  );
  // Video ids are time-ordered, so sorting descending guarantees newest-first.
  videos.sort((a: any, b: any) => Number(BigInt(b.id) - BigInt(a.id)));
  return { userInfo: profile.userInfo || {}, videos };
}

/** Convert an embed entry into the aweme shape `normalizeVideo` expects. */
export function embedItemToAweme(item: any): any {
  return {
    id: item.id,
    desc: item.desc || "",
    author: { uniqueId: item.authorUniqueId || "" },
    video: {
      cover: item.coverUrl || "",
      originCover: item.originCoverUrl || "",
      dynamicCover: item.dynamicCoverUrl || "",
      width: item.width,
      height: item.height,
      ratio: item.ratio,
    },
    stats: { playCount: item.playCount },
  };
}
