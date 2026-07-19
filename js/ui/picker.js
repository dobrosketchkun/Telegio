import {
  addPacks,
  bindStickerSrc,
  getPack,
  listEmojiRecents,
  listPacks,
  listRecents,
  parsePackList,
  pushEmojiRecent,
  pushRecent,
  removePack,
  stickerCorsFileUrl,
  stickerFileUrl,
  stickerSrcChain,
  stickerThumbUrl,
} from "../stickers.js";
import { ensureStickerCached } from "../sticker-cache.js";
import { EMOJI_CATEGORIES } from "./emoji-data.js";
import { emojiImg } from "./twemoji.js";

/** Flat list of all emoji characters (order = category order). */
export const EMOJI = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e[0]));

// Set true by the hold-preview when a press ends, so the ensuing synthetic
// `click` doesn't send the sticker. Cleared on the next click / pointerdown.
let suppressStickerClick = false;

/**
 * Telegram-style press-and-hold sticker preview. Holding a sticker in the grid
 * shows a large floating preview; dragging over another sticker swaps it;
 * releasing ends the preview WITHOUT sending (and keeps the picker open).
 * @param {HTMLElement} grid
 */
function enableStickerPreview(grid) {
  const HOLD_MS = 180;
  const MOVE_CANCEL = 10;
  let holdTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  let holding = false;
  let startX = 0;
  let startY = 0;
  /** @type {HTMLElement | null} */
  let previewEl = null;
  /** @type {HTMLElement | null} */
  let currentBtn = null;

  /** @param {MouseEvent} e */
  function stickerAtPoint(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const btn = el && el.closest ? el.closest(".picker__sticker") : null;
    return btn && grid.contains(btn) ? /** @type {HTMLElement} */ (btn) : null;
  }

  /** @param {HTMLElement} btn */
  function showPreview(btn) {
    const img = btn.querySelector("img");
    if (!img) return;
    currentBtn = btn;
    if (!previewEl) {
      previewEl = document.createElement("div");
      previewEl.className = "sticker-preview";
      const card = document.createElement("div");
      card.className = "sticker-preview__card";
      const pImg = document.createElement("img");
      pImg.alt = "";
      card.append(pImg);
      previewEl.append(card);
      document.body.append(previewEl);
    }
    const pImg = previewEl.querySelector("img");
    if (pImg) pImg.src = btn.dataset.full || img.currentSrc || img.src;
  }

  function cleanup() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (previewEl) {
      previewEl.remove();
      previewEl = null;
    }
    currentBtn = null;
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onUp, true);
  }

  /** @param {PointerEvent} e */
  function onMove(e) {
    if (holding) {
      e.preventDefault();
      const btn = stickerAtPoint(e);
      if (btn && btn !== currentBtn) showPreview(btn);
      return;
    }
    // Still within the tap window: a real drag/scroll cancels the pending hold.
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy > MOVE_CANCEL * MOVE_CANCEL) {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    }
  }

  function onUp() {
    if (holding) suppressStickerClick = true;
    holding = false;
    cleanup();
  }

  grid.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const btn = /** @type {HTMLElement} */ (e.target)?.closest?.(
      ".picker__sticker",
    );
    if (!btn || !grid.contains(btn)) return;
    suppressStickerClick = false;
    holding = false;
    startX = e.clientX;
    startY = e.clientY;
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    holdTimer = setTimeout(() => {
      holding = true;
      showPreview(/** @type {HTMLElement} */ (btn));
    }, HOLD_MS);
  });
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   onEmoji: (emoji: string) => void,
 *   onSticker: (ref: { pack: string, stickerId: string, emoji?: string }) => void,
 *   onRequestAddPacks: () => void,
 * }} hooks
 */
export function createPicker(root, hooks) {
  let tab = "emoji";
  /** @type {"recents" | string} */
  let activePack = "recents";
  let query = "";
  /** @type {HTMLElement | null} */
  let bodyEl = null;
  /** @type {HTMLElement | null} */
  let navEl = null;

  function render() {
    root.innerHTML = "";
    root.className = "picker";

    const header = document.createElement("div");
    header.className = "picker__header";

    const tabs = document.createElement("div");
    tabs.className = "picker__tabs";
    for (const [id, label] of [
      ["emoji", "Emoji"],
      ["stickers", "Stickers"],
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker__tab" + (tab === id ? " is-active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (tab === id) return;
        tab = id;
        query = "";
        render();
      });
      tabs.append(btn);
    }
    header.append(tabs);

    const searchWrap = document.createElement("div");
    searchWrap.className = "picker__search-wrap";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "picker__search";
    search.placeholder = "Search";
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value.trim().toLowerCase();
      renderBody();
    });
    searchWrap.append(search);
    header.append(searchWrap);
    root.append(header);

    bodyEl = document.createElement("div");
    bodyEl.className = "picker__body";
    root.append(bodyEl);

    navEl = document.createElement("div");
    root.append(navEl);

    renderBody();
  }

  function renderBody() {
    if (!bodyEl || !navEl) return;
    bodyEl.innerHTML = "";
    navEl.innerHTML = "";
    if (tab === "emoji") {
      renderEmojiBody();
      renderEmojiNav();
    } else {
      renderStickerBody();
      renderStrip();
    }
  }

  function renderEmojiBody() {
    if (query) {
      /** @type {string[]} */
      const matches = [];
      for (const cat of EMOJI_CATEGORIES) {
        for (const [ch, kw] of cat.emojis) {
          if (ch === query || kw.includes(query)) matches.push(ch);
        }
      }
      if (!matches.length) {
        bodyEl.append(emptyText("No emoji found"));
        return;
      }
      bodyEl.append(emojiGrid(matches));
      return;
    }

    const recents = listEmojiRecents();
    if (recents.length) {
      bodyEl.append(sectionHeader("Recently used"));
      bodyEl.append(emojiGrid(recents));
    }
    for (const cat of EMOJI_CATEGORIES) {
      const head = sectionHeader(cat.name);
      head.dataset.cat = cat.id;
      bodyEl.append(head);
      bodyEl.append(emojiGrid(cat.emojis.map((e) => e[0])));
    }
  }

  /** @param {string[]} chars */
  function emojiGrid(chars) {
    const grid = document.createElement("div");
    grid.className = "picker__emoji-grid";
    for (const ch of chars) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker__emoji";
      btn.title = ch;
      btn.append(emojiImg(ch));
      btn.addEventListener("click", () => {
        pushEmojiRecent(ch);
        hooks.onEmoji(ch);
      });
      grid.append(btn);
    }
    return grid;
  }

  function renderEmojiNav() {
    navEl.className = "picker__catnav";
    if (listEmojiRecents().length) {
      const recentsBtn = document.createElement("button");
      recentsBtn.type = "button";
      recentsBtn.className = "picker__catnav-btn";
      recentsBtn.title = "Recently used";
      recentsBtn.textContent = "🕘";
      recentsBtn.addEventListener("click", () => {
        query = "";
        renderBody();
        if (bodyEl) bodyEl.scrollTop = 0;
      });
      navEl.append(recentsBtn);
    }
    for (const cat of EMOJI_CATEGORIES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker__catnav-btn";
      btn.title = cat.name;
      btn.append(emojiImg(cat.icon));
      btn.addEventListener("click", () => {
        if (query) {
          query = "";
          renderBody();
        }
        scrollToCategory(cat.id);
        markActiveNav(cat.id);
      });
      btn.dataset.cat = cat.id;
      navEl.append(btn);
    }
  }

  /** @param {string} catId */
  function scrollToCategory(catId) {
    if (!bodyEl) return;
    const head = bodyEl.querySelector(`.picker__section[data-cat="${catId}"]`);
    if (!head) return;
    const top =
      head.getBoundingClientRect().top -
      bodyEl.getBoundingClientRect().top +
      bodyEl.scrollTop;
    bodyEl.scrollTop = top;
  }

  /** @param {string} catId */
  function markActiveNav(catId) {
    if (!navEl) return;
    for (const b of navEl.querySelectorAll(".picker__catnav-btn")) {
      b.classList.toggle("is-active", b.dataset.cat === catId);
    }
  }

  function renderStickerBody() {
    if (query) {
      /** @type {Array<{ pack: string, id: string, emoji?: string, thumbnail_url: string }>} */
      const items = [];
      for (const pack of listPacks()) {
        const packMatch =
          pack.title.toLowerCase().includes(query) ||
          pack.name.toLowerCase().includes(query);
        for (const s of pack.stickers) {
          if (packMatch || (s.emoji && s.emoji.includes(query))) {
            items.push({
              pack: pack.name,
              id: s.id,
              emoji: s.emoji,
              thumbnail_url: s.thumbnail_url,
            });
          }
        }
      }
      bodyEl.append(sectionHeader("Results"));
      if (!items.length) bodyEl.append(emptyText("No stickers found"));
      else bodyEl.append(stickerGrid(items));
      return;
    }

    if (activePack === "recents") {
      const recents = listRecents();
      bodyEl.append(sectionHeader("Recently used"));
      if (!recents.length) {
        bodyEl.append(emptyText("No recent stickers yet"));
      } else {
        bodyEl.append(
          stickerGrid(
            recents.map((r) => ({
              pack: r.pack,
              id: r.stickerId,
              emoji: r.emoji,
              thumbnail_url: stickerThumbUrl(r.pack, r.stickerId),
            })),
          ),
        );
      }
      return;
    }

    const pack = getPack(activePack);
    if (!pack) {
      activePack = "recents";
      renderStickerBody();
      return;
    }

    const head = document.createElement("div");
    head.className = "picker__pack-head";
    const title = document.createElement("span");
    title.textContent = pack.title || pack.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "btn btn--tiny";
    rm.textContent = "×";
    rm.title = "Remove pack";
    rm.addEventListener("click", () => {
      removePack(pack.name);
      activePack = "recents";
      renderBody();
    });
    head.append(title, rm);
    bodyEl.append(head);
    bodyEl.append(
      stickerGrid(
        pack.stickers.map((s) => ({
          pack: pack.name,
          id: s.id,
          emoji: s.emoji,
          thumbnail_url: s.thumbnail_url,
        })),
      ),
    );
  }

  /**
   * @param {Array<{ pack: string, id: string, emoji?: string, thumbnail_url: string }>} items
   */
  function stickerGrid(items) {
    const grid = document.createElement("div");
    grid.className = "picker__sticker-grid";
    for (const s of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker__sticker";
      btn.title = s.emoji || s.id;
      btn.dataset.full = stickerCorsFileUrl(s.pack, s.id);
      const img = document.createElement("img");
      img.alt = s.emoji || "sticker";
      img.loading = "lazy";
      img.draggable = false;
      bindStickerSrc(
        img,
        [
          s.thumbnail_url,
          stickerThumbUrl(s.pack, s.id),
          ...stickerSrcChain(s.pack, s.id, "thumb").slice(1),
          ...stickerSrcChain(s.pack, s.id, "file"),
        ],
        () => {
          img.replaceWith(document.createTextNode(s.emoji || "?"));
        },
      );
      btn.append(img);
      btn.addEventListener("click", () => {
        if (suppressStickerClick) {
          suppressStickerClick = false;
          return;
        }
        const ref = { pack: s.pack, stickerId: s.id, emoji: s.emoji };
        // Warm the byte cache so peers who can't reach the sticker site can pull.
        ensureStickerCached(ref.pack, ref.stickerId);
        pushRecent(ref);
        hooks.onSticker(ref);
      });
      grid.append(btn);
    }
    enableStickerPreview(grid);
    return grid;
  }

  function renderStrip() {
    navEl.className = "picker__strip";

    const recentsBtn = document.createElement("button");
    recentsBtn.type = "button";
    recentsBtn.className =
      "picker__strip-btn" + (activePack === "recents" ? " is-active" : "");
    recentsBtn.textContent = "🕘";
    recentsBtn.title = "Recently used";
    recentsBtn.addEventListener("click", () => {
      activePack = "recents";
      query = "";
      renderBody();
    });
    navEl.append(recentsBtn);

    for (const pack of listPacks()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "picker__strip-btn" + (activePack === pack.name ? " is-active" : "");
      btn.title = pack.title || pack.name;
      const thumb = pack.stickers[0];
      if (thumb) {
        const img = document.createElement("img");
        img.alt = "";
        bindStickerSrc(
          img,
          [
            thumb.thumbnail_url,
            ...stickerSrcChain(pack.name, thumb.id, "thumb"),
            ...stickerSrcChain(pack.name, thumb.id, "file"),
          ],
          () => {
            img.replaceWith(document.createTextNode(pack.name.slice(0, 1)));
          },
        );
        btn.append(img);
      } else {
        btn.textContent = pack.name.slice(0, 1);
      }
      btn.addEventListener("click", () => {
        activePack = pack.name;
        query = "";
        renderBody();
      });
      navEl.append(btn);
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "picker__strip-btn picker__strip-add";
    addBtn.textContent = "+";
    addBtn.title = "Add sticker packs";
    addBtn.addEventListener("click", () => hooks.onRequestAddPacks());
    navEl.append(addBtn);
  }

  /** @param {string} text */
  function sectionHeader(text) {
    const h = document.createElement("div");
    h.className = "picker__section";
    h.textContent = text;
    return h;
  }

  /** @param {string} text */
  function emptyText(text) {
    const p = document.createElement("p");
    p.className = "picker__empty";
    p.textContent = text;
    return p;
  }

  return {
    render,
    refresh: render,
    /**
     * After packs added, jump to the first new pack (switches to Stickers tab).
     * @param {string[]} [okNames]
     */
    focusPack(okNames) {
      tab = "stickers";
      query = "";
      if (okNames?.length) activePack = okNames[0];
      else if (listPacks().length) activePack = listPacks()[0].name;
      render();
    },
  };
}

/**
 * @param {string} text
 * @returns {Promise<{ ok: string[], errors: { input: string, error: string }[] }>}
 */
export async function addPacksFromText(text) {
  const names = parsePackList(text);
  if (!names.length) {
    return { ok: [], errors: [{ input: text, error: "No valid pack names" }] };
  }
  return addPacks(names);
}
