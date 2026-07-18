import { VIDEO_AUTO_DOWNLOAD_BYTES } from "../constants.js";
import { isFullyDelivered, renderEntities } from "../entities.js";
import { formatBytes } from "../media.js";
import { stickerFileUrl } from "../stickers.js";

/**
 * @param {HTMLElement} root
 * @param {Array<{ id: string, kind: string, title: string, preview: string, updatedAt: number }>} chats
 * @param {string | null} activeId
 * @param {Record<string, number>} unread
 * @param {(id: string) => void} onSelect
 */
export function renderChatList(root, chats, activeId, unread, onSelect) {
  root.innerHTML = "";
  for (const chat of chats) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "chat-list__item" + (chat.id === activeId ? " is-active" : "");
    btn.addEventListener("click", () => onSelect(chat.id));

    const av = document.createElement("div");
    av.className = `avatar avatar--g${hashHue(chat.id)}`;
    av.textContent = initials(chat.title);

    const main = document.createElement("div");
    main.className = "chat-list__main";
    main.innerHTML = `
      <div class="chat-list__row">
        <span class="chat-list__name"></span>
        <span class="chat-list__time"></span>
      </div>
      <div class="chat-list__preview"></div>
    `;
    main.querySelector(".chat-list__name").textContent = chat.title;
    main.querySelector(".chat-list__time").textContent = formatTime(chat.updatedAt);
    main.querySelector(".chat-list__preview").textContent = chat.preview;

    const right = document.createElement("div");
    right.className = "chat-list__right";
    const kind = document.createElement("div");
    kind.className = "chat-list__kind";
    kind.textContent = chat.kind === "dm" ? "DM" : "Group";
    right.append(kind);
    const count = unread[chat.id] || 0;
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = count > 99 ? "99+" : String(count);
      right.append(badge);
    }

    btn.append(av, main, right);
    li.append(btn);
    root.append(li);
  }
}

/**
 * @param {HTMLElement} headerEl
 * @param {HTMLElement} messagesEl
 * @param {object | null} thread
 * @param {string} selfPeerId
 * @param {import("../engine.js").HostState} hostState
 * @param {{
 *   isHost?: boolean,
 *   sessionEnded?: boolean,
 *   subtitle?: string,
 *   onDeleteGroup?: () => void,
 *   onDeleteMessage?: (messageId: string) => void,
 *   onReply?: (messageId: string) => void,
 *   onEdit?: (messageId: string) => void,
 *   getMediaUrl?: (mediaId: string) => string | null,
 *   getPlayableMediaUrl?: (mediaId: string, gate?: object) => string | null,
 *   getMediaMime?: (mediaId: string) => string | null,
 *   onOpenMedia?: (url: string) => void,
 *   onDownloadMedia?: (mediaId: string) => void,
 * }} [opts]
 */
export function renderThread(
  headerEl,
  messagesEl,
  thread,
  selfPeerId,
  hostState,
  opts = {},
) {
  if (!thread) {
    headerEl.innerHTML = `
      <div class="chat-header__left">
        <div class="chat-header__meta">
          <h1 class="chat-header__title">Select a chat</h1>
          <p class="chat-header__sub"></p>
        </div>
      </div>
    `;
    headerEl.querySelector(".chat-header__sub").textContent =
      opts.subtitle || "Create a DM or group to start";
    messagesEl.innerHTML = `
      <div class="empty">
        <div class="empty__card">Pick a chat from the list to view messages.</div>
      </div>
    `;
    return;
  }

  const { chat, messages, kind } = thread;
  let title = chat.title || "Chat";
  let sub =
    kind === "group"
      ? `${chat.memberPeerIds.length} members`
      : "private DM";

  if (kind === "dm") {
    const otherId = chat.memberPeerIds.find((p) => p !== selfPeerId);
    const other = hostState.roster.find((r) => r.peerId === otherId);
    title = other?.displayName || otherId || "DM";
  }

  headerEl.innerHTML = `
    <div class="chat-header__left">
      <div class="avatar avatar--g${hashHue(chat.id)}" style="width:42px;height:42px;font-size:15px"></div>
      <div class="chat-header__meta">
        <h1 class="chat-header__title"></h1>
        <p class="chat-header__sub"></p>
      </div>
    </div>
    <div class="chat-header__actions"></div>
  `;
  headerEl.querySelector(".avatar").textContent = initials(title);
  headerEl.querySelector(".chat-header__title").textContent = title;
  headerEl.querySelector(".chat-header__sub").textContent = sub;

  const actions = headerEl.querySelector(".chat-header__actions");
  if (
    kind === "group" &&
    opts.isHost &&
    !opts.sessionEnded &&
    typeof opts.onDeleteGroup === "function"
  ) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn btn--small";
    del.textContent = "Delete group";
    del.addEventListener("click", () => opts.onDeleteGroup());
    actions.append(del);
  }

  const prevScroll = {
    top: messagesEl.scrollTop,
    height: messagesEl.scrollHeight,
    nearBottom:
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
      80,
  };

  messagesEl.innerHTML = "";
  for (const msg of messages) {
    if (msg.kind === "system") {
      const sys = document.createElement("div");
      sys.className = "system-msg";
      sys.textContent = msg.text || "";
      messagesEl.append(sys);
      continue;
    }

    const outgoing = msg.senderPeerId === selfPeerId;
    const row = document.createElement("div");
    row.className =
      "message-row " + (outgoing ? "message-row--out" : "message-row--in");

    const bubble = document.createElement("div");
    bubble.className = "bubble " + (outgoing ? "bubble--out" : "bubble--in");

    if (kind === "group" && !outgoing) {
      const sender = hostState.roster.find((r) => r.peerId === msg.senderPeerId);
      const name = document.createElement("div");
      const ci = sender?.colorIndex ?? hashHue(msg.senderPeerId);
      name.className = `bubble__name bubble__name--c${ci % 5}`;
      name.textContent = sender?.displayName || msg.senderPeerId;
      bubble.append(name);
    }

    if (msg.replyTo) {
      const parent = messages.find((m) => m.id === msg.replyTo);
      const quote = document.createElement("div");
      quote.className = "bubble__quote";
      const qName = document.createElement("div");
      qName.className = "bubble__quote-name";
      if (parent) {
        const pSender = hostState.roster.find(
          (r) => r.peerId === parent.senderPeerId,
        );
        qName.textContent =
          parent.senderPeerId === selfPeerId
            ? "You"
            : pSender?.displayName || parent.senderPeerId || "Message";
      } else {
        qName.textContent = "Reply";
      }
      const qText = document.createElement("div");
      qText.className = "bubble__quote-text";
      qText.textContent = quotePreview(parent);
      quote.append(qName, qText);
      bubble.append(quote);
    }

    if (msg.kind === "sticker" && msg.sticker) {
      const media = document.createElement("div");
      media.className = "bubble__sticker";
      const img = document.createElement("img");
      img.className = "sticker-img";
      img.src = stickerFileUrl(msg.sticker.pack, msg.sticker.stickerId);
      img.alt = "sticker";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "sticker-fallback";
        fallback.textContent = "sticker";
        img.replaceWith(fallback);
      });
      media.append(img);
      bubble.append(media);
      bubble.classList.add("bubble--sticker");
    } else if (isVideoMessage(msg, opts) && msg.mediaIds?.length) {
      const wrap = document.createElement("div");
      wrap.className = "bubble__video";
      const mid = msg.mediaIds[0];
      const info = msg.mediaInfo?.[0];
      const size = Number(info?.size) || 0;
      const outgoing = msg.senderPeerId === selfPeerId;
      const mime = info?.mime;
      const url =
        typeof opts.getPlayableMediaUrl === "function"
          ? opts.getPlayableMediaUrl(mid, { size, mime, outgoing })
          : typeof opts.getMediaUrl === "function"
            ? opts.getMediaUrl(mid)
            : null;
      const needsDownload =
        !outgoing && size > VIDEO_AUTO_DOWNLOAD_BYTES && !url;
      if (url) {
        const video = document.createElement("video");
        video.className = "media-video";
        video.src = url;
        video.controls = true;
        video.playsInline = true;
        video.preload = "metadata";
        wrap.append(video);
      } else if (needsDownload || size > VIDEO_AUTO_DOWNLOAD_BYTES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "video-download";
        const thumb = info?.thumbDataUrl;
        if (thumb) {
          btn.classList.add("video-download--thumb");
          btn.style.backgroundImage = `url("${thumb}")`;
        }
        btn.innerHTML = `<span class="video-download__icon">▶</span><span class="video-download__label">Download video</span><span class="video-download__size"></span>`;
        const sizeEl = btn.querySelector(".video-download__size");
        if (sizeEl) {
          sizeEl.textContent = size ? formatBytes(size) : "";
        }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onDownloadMedia?.(mid);
        });
        wrap.append(btn);
      } else {
        const ph = document.createElement("div");
        ph.className = "media-placeholder";
        ph.textContent = size ? `Video… ${formatBytes(size)}` : "Video…";
        wrap.append(ph);
      }
      bubble.append(wrap);
      bubble.classList.add("bubble--video");
      if (msg.text) {
        const text = document.createElement("div");
        text.className = "bubble__text";
        text.append(renderEntities(msg.text, msg.entities));
        bubble.append(text);
      }
    } else if (isAudioMessage(msg, opts) && msg.mediaIds?.length) {
      const wrap = document.createElement("div");
      wrap.className = "bubble__audio";
      const mid = msg.mediaIds[0];
      const info = msg.mediaInfo?.[0];
      const size = Number(info?.size) || 0;
      const outgoing = msg.senderPeerId === selfPeerId;
      const mime = info?.mime;
      const url =
        typeof opts.getPlayableMediaUrl === "function"
          ? opts.getPlayableMediaUrl(mid, { size, mime, outgoing })
          : typeof opts.getMediaUrl === "function"
            ? opts.getMediaUrl(mid)
            : null;
      const needsDownload =
        !outgoing && size > VIDEO_AUTO_DOWNLOAD_BYTES && !url;
      if (url) {
        const audio = document.createElement("audio");
        audio.className = "media-audio";
        audio.src = url;
        audio.controls = true;
        audio.preload = "metadata";
        wrap.append(audio);
      } else if (needsDownload || size > VIDEO_AUTO_DOWNLOAD_BYTES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "video-download audio-download";
        btn.innerHTML = `<span class="video-download__icon">♪</span><span class="video-download__label">Download audio</span><span class="video-download__size"></span>`;
        const sizeEl = btn.querySelector(".video-download__size");
        if (sizeEl) {
          sizeEl.textContent = size ? formatBytes(size) : "";
        }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onDownloadMedia?.(mid);
        });
        wrap.append(btn);
      } else {
        const ph = document.createElement("div");
        ph.className = "media-placeholder";
        ph.textContent = size ? `Audio… ${formatBytes(size)}` : "Audio…";
        wrap.append(ph);
      }
      bubble.append(wrap);
      bubble.classList.add("bubble--audio");
      if (msg.text) {
        const text = document.createElement("div");
        text.className = "bubble__text";
        text.append(renderEntities(msg.text, msg.entities));
        bubble.append(text);
      }
    } else if (
      (msg.kind === "media" || msg.kind === "album") &&
      msg.mediaIds?.length
    ) {
      const wrap = document.createElement("div");
      wrap.className =
        msg.kind === "album" ? "bubble__album" : "bubble__photo";
      for (const mid of msg.mediaIds) {
        const url =
          typeof opts.getMediaUrl === "function" ? opts.getMediaUrl(mid) : null;
        if (url) {
          const img = document.createElement("img");
          img.className = "media-img";
          img.src = url;
          img.alt = "Photo";
          img.loading = "lazy";
          img.addEventListener("click", (e) => {
            e.stopPropagation();
            opts.onOpenMedia?.(url);
          });
          wrap.append(img);
        } else {
          const ph = document.createElement("div");
          ph.className = "media-placeholder";
          ph.textContent = "…";
          wrap.append(ph);
        }
      }
      bubble.append(wrap);
      bubble.classList.add(
        msg.kind === "album" ? "bubble--album" : "bubble--media",
      );
      if (msg.text) {
        const text = document.createElement("div");
        text.className = "bubble__text";
        text.append(renderEntities(msg.text, msg.entities));
        bubble.append(text);
      }
    } else {
      const text = document.createElement("div");
      text.className = "bubble__text";
      text.append(renderEntities(msg.text || "", msg.entities));
      bubble.append(text);
    }

    const meta = document.createElement("div");
    meta.className = "bubble__meta";
    if (msg.editedAt) {
      const edited = document.createElement("span");
      edited.className = "bubble__edited";
      edited.textContent = "edited";
      meta.append(edited);
    }
    const time = document.createElement("span");
    time.textContent = formatTime(msg.createdAt);
    meta.append(time);
    if (
      outgoing &&
      (msg.kind === "text" ||
        msg.kind === "sticker" ||
        msg.kind === "media" ||
        msg.kind === "album" ||
        msg.kind === "video" ||
        msg.kind === "audio" ||
        isVideoMessage(msg, opts) ||
        isAudioMessage(msg, opts))
    ) {
      const checks = document.createElement("span");
      checks.className = "checks";
      const delivered = isFullyDelivered(
        chat.memberPeerIds,
        msg.senderPeerId,
        msg.delivery?.ackedBy || [],
      );
      checks.classList.add(delivered ? "checks--double" : "checks--single");
      checks.innerHTML = delivered
        ? '<svg viewBox="0 0 16 10" width="16" height="10"><path d="M1 5l3 3 6-7M5 5l3 3 7-8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
        : '<svg viewBox="0 0 12 10" width="12" height="10"><path d="M1 5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
      meta.append(checks);
    }
    bubble.append(meta);

    const toolbar = document.createElement("div");
    toolbar.className = "bubble__toolbar";
    if (!opts.sessionEnded && typeof opts.onReply === "function") {
      const replyBtn = document.createElement("button");
      replyBtn.type = "button";
      replyBtn.className = "btn btn--tiny";
      replyBtn.textContent = "Reply";
      replyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onReply(msg.id);
      });
      toolbar.append(replyBtn);
    }
    if (
      !opts.sessionEnded &&
      outgoing &&
      msg.kind === "text" &&
      typeof opts.onEdit === "function"
    ) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn--tiny";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onEdit(msg.id);
      });
      toolbar.append(editBtn);
    }
    const canDelete =
      !opts.sessionEnded &&
      typeof opts.onDeleteMessage === "function" &&
      (kind === "dm"
        ? outgoing
        : opts.isHost || outgoing);
    if (canDelete) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn--tiny btn--danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onDeleteMessage(msg.id);
      });
      toolbar.append(delBtn);
    }
    if (toolbar.childNodes.length) bubble.append(toolbar);

    row.append(bubble);
    messagesEl.append(row);
  }

  if (prevScroll.nearBottom || prevScroll.height < 40) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    messagesEl.scrollTop = prevScroll.top;
  }
}

/**
 * Video bubble even when kind was wrongly stored as "media" (mime says video/*).
 * @param {import("../engine.js").Message | undefined} msg
 * @param {{ getMediaMime?: (mediaId: string) => string | null }} [opts]
 */
function isVideoMessage(msg, opts = {}) {
  if (!msg?.mediaIds?.length) return false;
  if (msg.kind === "video") return true;
  if (msg.kind !== "media" || msg.mediaIds.length !== 1) return false;
  const mid = msg.mediaIds[0];
  const fromInfo = msg.mediaInfo?.[0]?.mime;
  const fromStore =
    typeof opts.getMediaMime === "function" ? opts.getMediaMime(mid) : null;
  const mime = String(fromInfo || fromStore || "").toLowerCase();
  return mime.startsWith("video/");
}

/**
 * Audio bubble even when kind was wrongly stored as "media" (mime says audio/*).
 * @param {import("../engine.js").Message | undefined} msg
 * @param {{ getMediaMime?: (mediaId: string) => string | null }} [opts]
 */
function isAudioMessage(msg, opts = {}) {
  if (!msg?.mediaIds?.length) return false;
  if (msg.kind === "audio") return true;
  if (msg.kind !== "media" || msg.mediaIds.length !== 1) return false;
  const mid = msg.mediaIds[0];
  const fromInfo = msg.mediaInfo?.[0]?.mime;
  const fromStore =
    typeof opts.getMediaMime === "function" ? opts.getMediaMime(mid) : null;
  const mime = String(fromInfo || fromStore || "").toLowerCase();
  return mime.startsWith("audio/");
}

/** @param {import("../engine.js").Message | undefined} msg */
function quotePreview(msg) {
  if (!msg) return "Original message";
  if (msg.kind === "sticker") return "Sticker";
  if (msg.kind === "video" || isVideoMessage(msg)) {
    return msg.text?.trim() || "Video";
  }
  if (msg.kind === "audio" || isAudioMessage(msg)) {
    return msg.text?.trim() || "Audio";
  }
  if (msg.kind === "media") return msg.text?.trim() || "Photo";
  if (msg.kind === "album") return msg.text?.trim() || "Album";
  return msg.text || "Original message";
}

/** @param {string} name */
function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** @param {string} s */
function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 5;
}

/** @param {number} ts */
function formatTime(ts) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}
