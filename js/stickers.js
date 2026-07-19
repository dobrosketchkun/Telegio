export const PROXY_ORIGIN = "https://stickers.from.tg";
export const FIXTURE_PACK = "TofPaintSafe";

const PACKS_KEY = "ephchat.stickerPacks";
const RECENTS_KEY = "ephchat.stickerRecents";
const EMOJI_RECENTS_KEY = "ephchat.emojiRecents";
const MAX_RECENTS = 40;
const MAX_EMOJI_RECENTS = 32;

/**
 * stickers.from.tg serves pack JSON without Access-Control-Allow-Origin,
 * so browser fetch() fails (images via <img> still work). Try direct first,
 * then public CORS proxies for metadata only.
 * @type {((url: string) => string)[]}
 */
const PACK_JSON_FETCHERS = [
  (url) => url,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) =>
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

/**
 * Image CDN with CORS (*). Fetches the upstream sticker server-side, so peers
 * who can reach wsrv but not stickers.from.tg still get bytes — and so we can
 * `fetch()` sticker images in the browser (stickers.from.tg itself has no ACAO).
 * @param {string} upstreamUrl
 */
export function corsImageUrl(upstreamUrl) {
  return `https://wsrv.nl/?url=${encodeURIComponent(upstreamUrl)}`;
}

/** @param {string} pack @param {string} stickerId */
export function stickerCorsFileUrl(pack, stickerId) {
  return corsImageUrl(stickerFileUrl(pack, stickerId));
}

/** @param {string} pack @param {string} stickerId */
export function stickerCorsThumbUrl(pack, stickerId) {
  return corsImageUrl(stickerThumbUrl(pack, stickerId));
}

/**
 * Ordered display/fetch candidates: direct CDN, then CORS image proxy.
 * @param {string} pack @param {string} stickerId @param {"file" | "thumb"} [kind]
 * @returns {string[]}
 */
export function stickerSrcChain(pack, stickerId, kind = "file") {
  if (kind === "thumb") {
    return [
      stickerThumbUrl(pack, stickerId),
      stickerCorsThumbUrl(pack, stickerId),
    ];
  }
  return [stickerFileUrl(pack, stickerId), stickerCorsFileUrl(pack, stickerId)];
}

/**
 * Point an <img> at the first working URL in the chain. Calls onExhausted only
 * after every candidate fails (then peer-relay can take over).
 * @param {HTMLImageElement} img
 * @param {string[]} urls
 * @param {() => void} [onExhausted]
 */
export function bindStickerSrc(img, urls, onExhausted) {
  const chain = urls.filter(Boolean);
  let i = 0;
  if (!chain.length) {
    onExhausted?.();
    return;
  }
  const tryNext = () => {
    if (i >= chain.length) {
      onExhausted?.();
      return;
    }
    img.src = chain[i++];
  };
  img.addEventListener("error", tryNext);
  tryNext();
}

/**
 * Fetch raw sticker bytes for peer relay / local cache. Prefer the CORS image
 * proxy because stickers.from.tg has no Access-Control-Allow-Origin (so a peer
 * who can *see* stickers via <img> still couldn't fetch() them before).
 * @param {string} pack @param {string} stickerId
 * @returns {Promise<Blob>}
 */
export async function fetchStickerBytes(pack, stickerId) {
  /** @type {unknown} */
  let lastError = null;
  for (const url of stickerSrcChain(pack, stickerId, "file")) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const blob = await res.blob();
      if (!blob || blob.size === 0) {
        lastError = new Error("Empty sticker");
        continue;
      }
      // Reject HTML/JSON error pages some proxies return with a 200.
      if (blob.type && !blob.type.startsWith("image/")) {
        lastError = new Error(`Not an image (${blob.type})`);
        continue;
      }
      return blob.type ? blob : new Blob([blob], { type: "image/webp" });
    } catch (e) {
      lastError = e;
    }
  }
  const msg =
    lastError instanceof Error ? lastError.message : String(lastError || "");
  throw new Error(msg || "Sticker fetch failed");
}

/**
 * @typedef {{ id: string, emoji?: string, file_url: string, thumbnail_url: string }} StickerEntry
 * @typedef {{ name: string, title: string, stickers: StickerEntry[], addedAt: number }} StickerPack
 * @typedef {{ pack: string, stickerId: string, emoji?: string }} StickerRef
 */

/**
 * @param {string} input
 * @returns {string | null}
 */
export function parsePackRef(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.hostname === "t.me" || url.hostname === "telegram.me") {
      const m = url.pathname.match(/\/addstickers\/([^/]+)/i);
      if (m) return decodeURIComponent(m[1]);
    }
    if (url.hostname === "stickers.from.tg") {
      const part = url.pathname.split("/").filter(Boolean)[0];
      if (part) return decodeURIComponent(part);
    }
  } catch {
    /* bare name */
  }

  const bare = raw.replace(/^@/, "").split(/[/?#]/)[0];
  if (/^[A-Za-z0-9_]+$/.test(bare)) return bare;
  return null;
}

/**
 * Split textarea / list into pack name candidates.
 * @param {string} text
 * @returns {string[]}
 */
export function parsePackList(text) {
  const parts = String(text || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  /** @type {string[]} */
  const names = [];
  for (const p of parts) {
    const name = parsePackRef(p);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** @param {string} pack @param {string} stickerId */
export function stickerFileUrl(pack, stickerId) {
  return `${PROXY_ORIGIN}/${encodeURIComponent(pack)}/${encodeURIComponent(stickerId)}/file`;
}

/** @param {string} pack @param {string} stickerId */
export function stickerThumbUrl(pack, stickerId) {
  return `${PROXY_ORIGIN}/${encodeURIComponent(pack)}/${encodeURIComponent(stickerId)}/thumbnail`;
}

/**
 * @param {string} relativeOrAbsolute
 * @returns {string}
 */
function absolutize(relativeOrAbsolute) {
  if (!relativeOrAbsolute) return "";
  try {
    return new URL(relativeOrAbsolute, PROXY_ORIGIN).href;
  } catch {
    return relativeOrAbsolute;
  }
}

/**
 * Fetch pack JSON, bypassing missing CORS on the sticker proxy when needed.
 * @param {string} packName
 * @returns {Promise<object>}
 */
async function fetchPackJson(packName) {
  const url = `${PROXY_ORIGIN}/${encodeURIComponent(packName)}`;
  /** @type {unknown} */
  let lastError = null;
  for (const wrap of PACK_JSON_FETCHERS) {
    const fetchUrl = wrap(url);
    try {
      const res = await fetch(fetchUrl);
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      if (!data || typeof data !== "object") {
        lastError = new Error("Invalid pack JSON");
        continue;
      }
      return data;
    } catch (e) {
      lastError = e;
    }
  }
  const msg =
    lastError instanceof Error ? lastError.message : String(lastError || "");
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    throw new Error(
      "Blocked by CORS (proxy has no Access-Control-Allow-Origin)",
    );
  }
  throw new Error(msg || "Pack fetch failed");
}

/**
 * @param {string} name
 * @returns {Promise<StickerPack>}
 */
export async function fetchPack(name) {
  const packName = parsePackRef(name) || name;
  const data = await fetchPackJson(packName);
  if (!data?.exists && data?.exists !== undefined) {
    throw new Error(`Pack not found: ${packName}`);
  }
  const stickers = (Array.isArray(data.stickers) ? data.stickers : []).map(
    (s) => ({
      id: String(s.id),
      emoji: s.emoji || "",
      file_url: absolutize(s.file_url || stickerFileUrl(packName, s.id)),
      thumbnail_url: absolutize(
        s.thumbnail_url || stickerThumbUrl(packName, s.id),
      ),
    }),
  );
  if (!stickers.length) throw new Error(`Pack empty: ${packName}`);
  return {
    name: String(data.name || packName),
    title: String(data.title || packName),
    stickers,
    addedAt: Date.now(),
  };
}

/** @returns {StickerPack[]} */
export function listPacks() {
  try {
    const raw = localStorage.getItem(PACKS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** @param {StickerPack[]} packs */
function savePacks(packs) {
  localStorage.setItem(PACKS_KEY, JSON.stringify(packs));
}

/**
 * @param {string[]} names
 * @returns {Promise<{ ok: string[], errors: { input: string, error: string }[] }>}
 */
export async function addPacks(names) {
  /** @type {string[]} */
  const ok = [];
  /** @type {{ input: string, error: string }[]} */
  const errors = [];
  const packs = listPacks();

  await Promise.all(
    names.map(async (input) => {
      const name = parsePackRef(input) || input;
      try {
        if (packs.some((p) => p.name === name)) {
          ok.push(name);
          return;
        }
        const pack = await fetchPack(name);
        packs.push(pack);
        ok.push(pack.name);
      } catch (e) {
        errors.push({ input, error: e?.message || String(e) });
      }
    }),
  );

  savePacks(packs);
  return { ok, errors };
}

/** @param {string} name */
export function removePack(name) {
  savePacks(listPacks().filter((p) => p.name !== name));
}

/** @param {string} name @returns {StickerPack | undefined} */
export function getPack(name) {
  return listPacks().find((p) => p.name === name);
}

/**
 * Install a pack object without network (fixture stub / cache).
 * @param {StickerPack} pack
 */
export function upsertPack(pack) {
  const packs = listPacks().filter((p) => p.name !== pack.name);
  packs.push(pack);
  savePacks(packs);
}

/** @returns {StickerRef[]} */
export function listRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** @param {StickerRef} ref */
export function pushRecent(ref) {
  const next = [
    { pack: ref.pack, stickerId: ref.stickerId, emoji: ref.emoji },
    ...listRecents().filter(
      (r) => !(r.pack === ref.pack && r.stickerId === ref.stickerId),
    ),
  ].slice(0, MAX_RECENTS);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

/** @returns {string[]} */
export function listEmojiRecents() {
  try {
    const raw = localStorage.getItem(EMOJI_RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** @param {string} emoji */
export function pushEmojiRecent(emoji) {
  if (!emoji) return;
  const next = [emoji, ...listEmojiRecents().filter((e) => e !== emoji)].slice(
    0,
    MAX_EMOJI_RECENTS,
  );
  try {
    localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* storage full / unavailable */
  }
}

/**
 * Ensure fixture pack is available (fetch or stub).
 * @returns {Promise<StickerPack>}
 */
export async function ensureFixturePacks() {
  const existing = getPack(FIXTURE_PACK);
  if (existing?.stickers?.length) return existing;
  try {
    const pack = await fetchPack(FIXTURE_PACK);
    upsertPack(pack);
    return pack;
  } catch {
    const stub = {
      name: FIXTURE_PACK,
      title: "Tom of Finland Paints SAFE",
      addedAt: Date.now(),
      stickers: [
        {
          id: "AgADegEAAki6kgc",
          emoji: "📖",
          file_url: stickerFileUrl(FIXTURE_PACK, "AgADegEAAki6kgc"),
          thumbnail_url: stickerThumbUrl(FIXTURE_PACK, "AgADegEAAki6kgc"),
        },
        {
          id: "AgADfAEAAki6kgc",
          emoji: "🚬",
          file_url: stickerFileUrl(FIXTURE_PACK, "AgADfAEAAki6kgc"),
          thumbnail_url: stickerThumbUrl(FIXTURE_PACK, "AgADfAEAAki6kgc"),
        },
        {
          id: "AgADggEAAki6kgc",
          emoji: "💪",
          file_url: stickerFileUrl(FIXTURE_PACK, "AgADggEAAki6kgc"),
          thumbnail_url: stickerThumbUrl(FIXTURE_PACK, "AgADggEAAki6kgc"),
        },
      ],
    };
    upsertPack(stub);
    return stub;
  }
}
