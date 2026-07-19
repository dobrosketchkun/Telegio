import {
  addPacks,
  getPack,
  listPacks,
  listRecents,
  parsePackList,
  pushRecent,
  removePack,
  stickerThumbUrl,
} from "../stickers.js";

export const EMOJI = [
  "😀", "😃", "😄", "😁", "😅", "😂", "🤣", "😊", "😇", "🙂", "😉", "😍",
  "🥰", "😘", "😗", "😋", "😜", "🤪", "😎", "🤩", "🥳", "😏", "😒", "🙄",
  "😢", "😭", "😤", "😠", "🤬", "🤯", "😳", "🤗", "🤔", "🤭", "🤫", "😶",
  "👍", "👎", "👏", "🙌", "🤝", "🙏", "💪", "🔥", "⭐", "❤️", "🧡", "💛",
  "💚", "💙", "💜", "🖤", "💔", "💯", "✨", "🎉", "🎊", "✅", "❌", "💤",
];

/**
 * @param {HTMLElement} root
 * @param {{
 *   onEmoji: (emoji: string) => void,
 *   onSticker: (ref: { pack: string, stickerId: string, emoji?: string }) => void,
 *   onRequestAddPacks: () => void,
 * }} hooks
 */
export function createPicker(root, hooks) {
  let tab = "stickers";
  /** @type {"recents" | string} */
  let activePack = "recents";

  function render() {
    root.innerHTML = "";
    root.className = "picker";

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
        tab = id;
        render();
      });
      tabs.append(btn);
    }
    root.append(tabs);

    const body = document.createElement("div");
    body.className = "picker__body";
    if (tab === "emoji") {
      body.append(renderEmoji());
    } else {
      body.append(renderStickers());
    }
    root.append(body);

    if (tab === "stickers") {
      root.append(renderStrip());
    }
  }

  function renderEmoji() {
    const grid = document.createElement("div");
    grid.className = "picker__emoji-grid";
    for (const emo of EMOJI) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker__emoji";
      btn.textContent = emo;
      btn.addEventListener("click", () => hooks.onEmoji(emo));
      grid.append(btn);
    }
    return grid;
  }

  function renderStickers() {
    const wrap = document.createElement("div");
    wrap.className = "picker__stickers";

    if (activePack === "recents") {
      const recents = listRecents();
      wrap.append(sectionHeader("Recently used"));
      if (!recents.length) {
        const empty = document.createElement("p");
        empty.className = "picker__empty";
        empty.textContent = "No recent stickers yet";
        wrap.append(empty);
      } else {
        wrap.append(stickerGrid(recents.map((r) => ({
          pack: r.pack,
          id: r.stickerId,
          emoji: r.emoji,
          thumbnail_url: stickerThumbUrl(r.pack, r.stickerId),
        }))));
      }
      return wrap;
    }

    const pack = getPack(activePack);
    if (!pack) {
      activePack = "recents";
      return renderStickers();
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
      render();
    });
    head.append(title, rm);
    wrap.append(head);
    wrap.append(stickerGrid(pack.stickers.map((s) => ({
      pack: pack.name,
      id: s.id,
      emoji: s.emoji,
      thumbnail_url: s.thumbnail_url,
    }))));
    return wrap;
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
      const img = document.createElement("img");
      img.src = s.thumbnail_url || stickerThumbUrl(s.pack, s.id);
      img.alt = s.emoji || "sticker";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.replaceWith(document.createTextNode(s.emoji || "?"));
      });
      btn.append(img);
      btn.addEventListener("click", () => {
        const ref = { pack: s.pack, stickerId: s.id, emoji: s.emoji };
        pushRecent(ref);
        hooks.onSticker(ref);
        render();
      });
      grid.append(btn);
    }
    return grid;
  }

  function renderStrip() {
    const strip = document.createElement("div");
    strip.className = "picker__strip";

    const recentsBtn = document.createElement("button");
    recentsBtn.type = "button";
    recentsBtn.className =
      "picker__strip-btn" + (activePack === "recents" ? " is-active" : "");
    recentsBtn.textContent = "⏱";
    recentsBtn.title = "Recently used";
    recentsBtn.addEventListener("click", () => {
      activePack = "recents";
      render();
    });
    strip.append(recentsBtn);

    for (const pack of listPacks()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "picker__strip-btn" + (activePack === pack.name ? " is-active" : "");
      btn.title = pack.title || pack.name;
      const thumb = pack.stickers[0];
      if (thumb) {
        const img = document.createElement("img");
        img.src = thumb.thumbnail_url;
        img.alt = "";
        img.addEventListener("error", () => {
          img.replaceWith(document.createTextNode(pack.name.slice(0, 1)));
        });
        btn.append(img);
      } else {
        btn.textContent = pack.name.slice(0, 1);
      }
      btn.addEventListener("click", () => {
        activePack = pack.name;
        render();
      });
      strip.append(btn);
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "picker__strip-btn picker__strip-add";
    addBtn.textContent = "+";
    addBtn.title = "Add sticker packs";
    addBtn.addEventListener("click", () => hooks.onRequestAddPacks());
    strip.append(addBtn);

    return strip;
  }

  /** @param {string} text */
  function sectionHeader(text) {
    const h = document.createElement("div");
    h.className = "picker__section";
    h.textContent = text;
    return h;
  }

  return {
    render,
    refresh: render,
    /**
     * After packs added, jump to first new pack if any.
     * @param {string[]} [okNames]
     */
    focusPack(okNames) {
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
