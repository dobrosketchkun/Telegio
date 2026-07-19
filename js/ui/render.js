import { VIDEO_AUTO_DOWNLOAD_BYTES } from "../constants.js";
import { isFullyDelivered, renderEntities } from "../entities.js";
import {
  fileIconKind,
  formatBytes,
  middleTruncate,
} from "../media.js";
import { bindStickerSrc, stickerSrcChain } from "../stickers.js";
import { cachedStickerUrl, warmStickerUrl } from "../sticker-cache.js";
import { verifyHandle } from "../tripcode.js";
import { EMOJI } from "./picker.js";
import { emojiImg, twemojify } from "./twemoji.js";

export const REACTION_EMOJIS = ["👍", "❤️", "🔥", "🎉", "😂", "😮", "😢", "🙏"];

// Tripcode verification is async (Ed25519); positives are cached so the row
// signature can pick them up on the next paint. `attemptedTrips` prevents
// re-verifying the same claim every frame.
const verifiedTrips = new Map();
const attemptedTrips = new Set();

/**
 * Return the verified tripcode id for a peer, or "" if unknown/invalid. Kicks
 * off async verification on first sight and repaints once it resolves.
 * @param {string} peerId
 * @param {{ id?: string, pub?: string, sig?: string } | undefined} trip
 * @param {() => void} [requestRepaint]
 * @returns {string}
 */
function verifiedTripId(peerId, trip, requestRepaint) {
  if (!peerId || !trip?.id || !trip?.pub || !trip?.sig) return "";
  const key = `${peerId}:${trip.sig}`;
  if (verifiedTrips.get(key)) return trip.id;
  if (!attemptedTrips.has(key)) {
    attemptedTrips.add(key);
    verifyHandle(peerId, trip)
      .then((ok) => {
        if (ok) {
          verifiedTrips.set(key, true);
          requestRepaint?.();
        }
      })
      .catch(() => {});
  }
  return "";
}

/** @param {string} tripId */
function makeTripBadge(tripId) {
  const badge = document.createElement("span");
  badge.className = "trip-badge";
  badge.textContent = `!${tripId}`;
  badge.title = "Verified identity code";
  return badge;
}

const ICON_PIN =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3Z"/></svg>';
const ICON_MUTE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 3a5 5 0 0 0-5 5v2.6c0 .8-.3 1.6-.9 2.2L4 15h6m4 0h4l-1.1-1.1c-.6-.6-.9-1.4-.9-2.2V8a5 5 0 0 0-2.3-4.2M10 18a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><line x1="4" y1="3" x2="20" y2="21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

/**
 * @param {HTMLElement} root
 * @param {Array<{ id: string, kind: string, title: string, preview: string, updatedAt: number }>} chats
 * @param {string | null} activeId
 * @param {Record<string, number>} unread
 * @param {(id: string) => void} onSelect
 * @param {{
 *   pinnedIds?: string[],
 *   mutedIds?: string[],
 *   onTogglePin?: (chatId: string) => void,
 *   onToggleMute?: (chatId: string) => void,
 *   emptyHint?: string,
 * }} [opts]
 */
export function renderChatList(root, chats, activeId, unread, onSelect, opts = {}) {
  root.innerHTML = "";
  const pinned = new Set(opts.pinnedIds || []);
  const muted = new Set(opts.mutedIds || []);

  if (!chats.length) {
    const empty = document.createElement("li");
    empty.className = "chat-list__empty";
    empty.textContent =
      opts.emptyHint || "Share the invite to start chatting";
    root.append(empty);
    return;
  }

  for (const chat of chats) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "chat-list__item" +
      (chat.id === activeId ? " is-active" : "") +
      (pinned.has(chat.id) ? " is-pinned" : "") +
      (muted.has(chat.id) ? " is-muted" : "");
    btn.addEventListener("click", () => onSelect(chat.id));

    if (chat.offline) btn.classList.add("chat-list__item--offline");

    const av = document.createElement("div");
    av.className = `avatar avatar--g${hashHue(chat.id)}`;
    av.textContent = initials(chat.title);

    const main = document.createElement("div");
    main.className = "chat-list__main";
    main.innerHTML = `
      <div class="chat-list__row">
        <span class="chat-list__name"></span>
        <span class="chat-list__nameicons"></span>
        <span class="chat-list__time"></span>
      </div>
      <div class="chat-list__preview"></div>
    `;
    const nameEl = main.querySelector(".chat-list__name");
    nameEl.textContent = chat.title;
    if (chat.kind === "dm" && chat.trip) {
      const tripId = verifiedTripId(
        chat.tripPeerId,
        chat.trip,
        opts.requestRepaint,
      );
      if (tripId) nameEl.append(makeTripBadge(tripId));
    }
    const nameIcons = main.querySelector(".chat-list__nameicons");
    if (muted.has(chat.id)) {
      const mute = document.createElement("span");
      mute.className = "chat-list__icon chat-list__icon--mute";
      mute.innerHTML = ICON_MUTE;
      mute.title = "Muted";
      nameIcons.append(mute);
    }
    main.querySelector(".chat-list__time").textContent = formatTime(chat.updatedAt);
    const previewEl = main.querySelector(".chat-list__preview");
    previewEl.textContent = chat.offline
      ? chat.preview
        ? `Offline · ${chat.preview}`
        : "Offline"
      : chat.preview;

    const right = document.createElement("div");
    right.className = "chat-list__right";
    const kind = document.createElement("div");
    kind.className = "chat-list__kind";
    kind.textContent = chat.kind === "dm" ? "DM" : "Group";
    right.append(kind);
    const count = muted.has(chat.id) ? 0 : unread[chat.id] || 0;
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "unread-badge";
      badge.textContent = count > 99 ? "99+" : String(count);
      right.append(badge);
    } else if (pinned.has(chat.id)) {
      const pin = document.createElement("span");
      pin.className = "chat-list__icon chat-list__icon--pin";
      pin.innerHTML = ICON_PIN;
      pin.title = "Pinned";
      right.append(pin);
    }

    const buildChatActions = () => {
      /** @type {{ label: string, danger?: boolean, onClick: () => void }[]} */
      const actions = [];
      if (typeof opts.onTogglePin === "function") {
        actions.push({
          label: pinned.has(chat.id) ? "Unpin" : "Pin",
          onClick: () => opts.onTogglePin(chat.id),
        });
      }
      if (typeof opts.onToggleMute === "function") {
        actions.push({
          label: muted.has(chat.id) ? "Unmute" : "Mute",
          onClick: () => opts.onToggleMute(chat.id),
        });
      }
      return actions;
    };
    if (buildChatActions().length) {
      attachContextTrigger(btn, (px, py) => {
        const actions = buildChatActions();
        if (actions.length) openContextMenu(px, py, { actions });
      });
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
 *   onAddMembers?: () => void,
 *   onDeleteMessage?: (messageId: string) => void,
 *   onReply?: (messageId: string) => void,
 *   onEdit?: (messageId: string) => void,
 *   onReact?: (messageId: string, emoji: string) => void,
 *   onForward?: (messageId: string) => void,
 *   onBack?: () => void,
 *   getMediaUrl?: (mediaId: string) => string | null,
 *   getPlayableMediaUrl?: (mediaId: string, gate?: object) => string | null,
 *   getMediaMime?: (mediaId: string) => string | null,
 *   onOpenMedia?: (mediaId: string, messageId: string) => void,
 *   onDownloadMedia?: (mediaId: string) => void,
 *   onStickerError?: (pack: string, stickerId: string, senderPeerId?: string) => void,
 *   onStickerLoaded?: (pack: string, stickerId: string) => void,
 *   onRefetchSticker?: (pack: string, stickerId: string, senderPeerId?: string) => void,
 *   requestRepaint?: () => void,
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
    headerEl.dataset.sig = "";
    messagesEl.innerHTML = `
      <div class="empty">
        <div class="empty__card">Pick a chat from the list to view messages.</div>
      </div>
    `;
    messagesEl.dataset.threadId = "";
    return;
  }

  const { chat, messages, kind } = thread;
  let title = chat.title || "Chat";
  let sub =
    kind === "group"
      ? `${chat.memberPeerIds.length} members`
      : "private DM";

  let titleTripId = "";
  if (kind === "dm") {
    const otherId = chat.memberPeerIds.find((p) => p !== selfPeerId);
    const other = hostState.roster.find((r) => r.peerId === otherId);
    title = other?.displayName || otherId || "DM";
    titleTripId = verifiedTripId(otherId, other?.trip, opts.requestRepaint);
  }

  // —— Header: only rebuild when something visible changed (avoids recreating
  // buttons/menus on every network event). ——
  const canAdd =
    kind === "group" &&
    !opts.sessionEnded &&
    typeof opts.onAddMembers === "function";
  const canDeleteGroup =
    kind === "group" &&
    opts.isHost &&
    !opts.sessionEnded &&
    typeof opts.onDeleteGroup === "function";
  const headerSig = [
    chat.id,
    title,
    sub,
    kind,
    canAdd ? 1 : 0,
    canDeleteGroup ? 1 : 0,
    typeof opts.onBack === "function" ? 1 : 0,
    `v:${titleTripId}`,
  ].join("~");
  if (headerEl.dataset.sig !== headerSig) {
    headerEl.dataset.sig = headerSig;
    headerEl.innerHTML = `
      <div class="chat-header__left">
        <button type="button" class="btn btn--small chat-header__back" id="chat-back" aria-label="Back to chats" hidden>←</button>
        <div class="avatar avatar--g${hashHue(chat.id)}" style="width:42px;height:42px;font-size:15px"></div>
        <div class="chat-header__meta">
          <h1 class="chat-header__title"></h1>
          <p class="chat-header__sub"></p>
        </div>
      </div>
      <div class="chat-header__actions"></div>
    `;
    headerEl.querySelector(".avatar").textContent = initials(title);
    const titleEl = headerEl.querySelector(".chat-header__title");
    titleEl.textContent = title;
    if (titleTripId) titleEl.append(makeTripBadge(titleTripId));
    headerEl.querySelector(".chat-header__sub").textContent = sub;

    const backBtn = headerEl.querySelector("#chat-back");
    if (backBtn && typeof opts.onBack === "function") {
      backBtn.hidden = false;
      backBtn.addEventListener("click", () => opts.onBack());
    }

    const actions = headerEl.querySelector(".chat-header__actions");
    /** @type {{ label: string, danger?: boolean, onClick: () => void }[]} */
    const menuItems = [];
    if (canAdd) {
      menuItems.push({ label: "Add members", onClick: () => opts.onAddMembers() });
    }
    if (canDeleteGroup) {
      menuItems.push({
        label: "Delete group",
        danger: true,
        onClick: () => opts.onDeleteGroup(),
      });
    }
    if (menuItems.length) {
      actions.append(buildHeaderMenu(menuItems));
    }
  }

  // —— Messages: reconcile keyed rows instead of wiping innerHTML, so unchanged
  // rows (and especially live <video>/<audio>) survive network-driven repaints. ——
  const threadChanged = messagesEl.dataset.threadId !== chat.id;
  const prevScroll = {
    top: messagesEl.scrollTop,
    height: messagesEl.scrollHeight,
    nearBottom:
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
      80,
  };
  if (threadChanged) messagesEl.innerHTML = "";

  const existing = new Map();
  for (const child of Array.from(messagesEl.children)) {
    if (child.dataset && child.dataset.mid) {
      existing.set(child.dataset.mid, child);
    } else {
      child.remove();
    }
  }

  const dayKeyOf = (m) =>
    m && m.createdAt ? new Date(m.createdAt).toDateString() : "";

  const desired = [];
  let prevDayKey = null;
  messages.forEach((msg, index) => {
    const isSystem = msg.kind === "system";
    const dayKey = dayKeyOf(msg);

    // Date separator whenever the calendar day changes.
    if (!isSystem && dayKey && dayKey !== prevDayKey) {
      const sepMid = `date:${dayKey}`;
      const sepSig = `date~${dayKey}`;
      const oldSep = existing.get(sepMid);
      let sepNode;
      if (oldSep && oldSep.dataset.sig === sepSig) {
        sepNode = oldSep;
      } else {
        sepNode = buildDateSeparator(msg.createdAt);
        sepNode.dataset.mid = sepMid;
        sepNode.dataset.sig = sepSig;
      }
      desired.push(sepNode);
      prevDayKey = dayKey;
    }

    // Run grouping: consecutive non-system messages from the same sender on the
    // same day form a "run" (drives avatar, tail, and sender-name display).
    const prev = messages[index - 1];
    const next = messages[index + 1];
    const sameAsPrev =
      !isSystem &&
      prev &&
      prev.kind !== "system" &&
      prev.senderPeerId === msg.senderPeerId &&
      dayKeyOf(prev) === dayKey;
    const sameAsNext =
      !isSystem &&
      next &&
      next.kind !== "system" &&
      next.senderPeerId === msg.senderPeerId &&
      dayKeyOf(next) === dayKey;
    const flags = { firstOfRun: !sameAsPrev, lastOfRun: !sameAsNext };

    const mid = msg.id || `sys:${msg.createdAt || 0}:${index}`;
    const sig = sigFor(msg, flags);
    const old = existing.get(mid);
    let node;
    if (old && old.dataset.sig === sig) {
      node = old;
    } else {
      node = buildRow(msg, flags);
      node.dataset.mid = mid;
      node.dataset.sig = sig;
      if (old) preservePlayingMedia(old, node);
    }
    desired.push(node);
  });

  const desiredSet = new Set(desired);
  for (const child of Array.from(messagesEl.children)) {
    if (!desiredSet.has(child)) child.remove();
  }
  desired.forEach((node, i) => {
    const current = messagesEl.children[i];
    if (current !== node) messagesEl.insertBefore(node, current || null);
  });

  messagesEl.dataset.threadId = chat.id;

  if (prevScroll.nearBottom || prevScroll.height < 40 || threadChanged) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    messagesEl.scrollTop = prevScroll.top;
  }

  /**
   * Compact per-message signature: rebuild the row only when one of these changes.
   * @param {import("../engine.js").Message} msg
   * @param {{ firstOfRun: boolean, lastOfRun: boolean }} [flags]
   */
  function sigFor(msg, flags) {
    if (msg.kind === "system") return `sys~${msg.text || ""}`;
    const outgoing = msg.senderPeerId === selfPeerId;
    const parts = [
      msg.kind,
      msg.text || "",
      msg.editedAt || 0,
      msg.replyTo || "",
      msg.forward ? `fwd:${msg.forward.fromName || ""}` : "",
      msg.sticker
        ? `st:${msg.sticker.pack}/${msg.sticker.stickerId}${
            cachedStickerUrl(msg.sticker.pack, msg.sticker.stickerId) ? ":c" : ""
          }`
        : "",
      `o:${outgoing ? 1 : 0}`,
      `t:${msg.createdAt || 0}`,
      `g:${flags?.firstOfRun ? 1 : 0}${flags?.lastOfRun ? 1 : 0}`,
    ];
    const sender = hostState.roster.find((r) => r.peerId === msg.senderPeerId);
    parts.push(`n:${sender?.displayName || msg.senderPeerId || ""}`);
    parts.push(
      `v:${verifiedTripId(msg.senderPeerId, sender?.trip, opts.requestRepaint)}`,
    );
    if (msg.mediaIds?.length) {
      parts.push(
        "m:" +
          msg.mediaIds
            .map((id, i) => {
              const info = msg.mediaInfo?.[i];
              const plain =
                typeof opts.getMediaUrl === "function" && opts.getMediaUrl(id)
                  ? 1
                  : 0;
              const play =
                typeof opts.getPlayableMediaUrl === "function" &&
                opts.getPlayableMediaUrl(id, {
                  size: Number(info?.size) || 0,
                  mime: info?.mime,
                  outgoing,
                })
                  ? 1
                  : 0;
              return `${id}#${plain}${play}`;
            })
            .join("|"),
      );
      parts.push(
        "mi:" +
          (msg.mediaInfo || [])
            .map(
              (mi) =>
                `${mi?.size || 0}/${mi?.mime || ""}/${mi?.fileName || ""}/${
                  mi?.thumbDataUrl ? 1 : 0
                }`,
            )
            .join("|"),
      );
    }
    if (msg.reactions?.length) {
      parts.push(
        "r:" +
          msg.reactions
            .map(
              (r) =>
                `${r.emoji}:${r.peerIds?.length || 0}:${
                  r.peerIds?.includes(selfPeerId) ? 1 : 0
                }`,
            )
            .join(","),
      );
    }
    if (outgoing) {
      const delivered = isFullyDelivered(
        chat.memberPeerIds,
        msg.senderPeerId,
        msg.delivery?.ackedBy || [],
      );
      parts.push(`d:${delivered ? 1 : 0}`);
    }
    return parts.join("~");
  }

  /**
   * @param {import("../engine.js").Message} msg
   * @param {{ firstOfRun: boolean, lastOfRun: boolean }} [flags]
   */
  function buildRow(msg, flags = { firstOfRun: true, lastOfRun: true }) {
    if (msg.kind === "system") {
      const sys = document.createElement("div");
      sys.className = "system-msg";
      sys.textContent = msg.text || "";
      return sys;
    }

    const outgoing = msg.senderPeerId === selfPeerId;
    const groupIncoming = kind === "group" && !outgoing;
    const row = document.createElement("div");
    row.className =
      "message-row " +
      (outgoing ? "message-row--out" : "message-row--in") +
      (flags.lastOfRun ? " message-row--run-end" : "");

    // Group incoming: reserve a left gutter for the sender avatar; the avatar
    // itself only shows on the last bubble of the run (Telegram-style).
    if (groupIncoming) {
      const gutter = document.createElement("div");
      gutter.className = "message-row__avatar";
      if (flags.lastOfRun) {
        const sender = hostState.roster.find(
          (r) => r.peerId === msg.senderPeerId,
        );
        gutter.classList.add("avatar", `avatar--g${hashHue(msg.senderPeerId)}`);
        gutter.textContent = initials(sender?.displayName || msg.senderPeerId);
      } else {
        gutter.classList.add("message-row__avatar--spacer");
      }
      row.append(gutter);
    }

    const bubble = document.createElement("div");
    bubble.className =
      "bubble " +
      (outgoing ? "bubble--out" : "bubble--in") +
      (flags.lastOfRun ? " bubble--tail" : "");

    if (groupIncoming && flags.firstOfRun) {
      const sender = hostState.roster.find((r) => r.peerId === msg.senderPeerId);
      const name = document.createElement("div");
      const ci = sender?.colorIndex ?? hashHue(msg.senderPeerId);
      name.className = `bubble__name bubble__name--c${ci % 5}`;
      name.textContent = sender?.displayName || msg.senderPeerId;
      const tripId = verifiedTripId(
        msg.senderPeerId,
        sender?.trip,
        opts.requestRepaint,
      );
      if (tripId) name.append(makeTripBadge(tripId));
      bubble.append(name);
    }

    if (msg.forward) {
      const fwd = document.createElement("div");
      fwd.className = "bubble__forward";
      fwd.textContent = `Forwarded from ${msg.forward.fromName || "Someone"}`;
      bubble.append(fwd);
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
      const { pack, stickerId } = msg.sticker;
      const media = document.createElement("div");
      media.className = "bubble__sticker";
      const img = document.createElement("img");
      img.className = "sticker-img";
      img.alt = "sticker";
      img.loading = "lazy";
      const cached = cachedStickerUrl(pack, stickerId);
      // IndexedDB may have bytes we haven't hydrated yet — warm + repaint.
      if (!cached) {
        warmStickerUrl(pack, stickerId).then((url) => {
          if (url) opts.requestRepaint?.();
        });
      }
      img.addEventListener("load", () => {
        if (!cached) opts.onStickerLoaded?.(pack, stickerId);
      });
      // cached → direct CDN → CORS image proxy → peer pull.
      bindStickerSrc(
        img,
        cached
          ? [cached, ...stickerSrcChain(pack, stickerId, "file")]
          : stickerSrcChain(pack, stickerId, "file"),
        () => {
          const fallback = document.createElement("span");
          fallback.className = "sticker-fallback";
          fallback.textContent = "sticker";
          img.replaceWith(fallback);
          opts.onStickerError?.(pack, stickerId, msg.senderPeerId);
        },
      );
      media.append(img);
      if (typeof opts.onOpenStickerPack === "function") {
        media.classList.add("bubble__sticker--clickable");
        media.setAttribute("role", "button");
        media.setAttribute("tabindex", "0");
        const open = (e) => {
          e.preventDefault();
          e.stopPropagation();
          opts.onOpenStickerPack({
            pack: msg.sticker.pack,
            stickerId: msg.sticker.stickerId,
            emoji: msg.sticker.emoji,
            senderPeerId: msg.senderPeerId,
          });
        };
        media.addEventListener("click", open);
        media.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") open(e);
        });
      }
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
        if (info?.thumbDataUrl) video.poster = info.thumbDataUrl;
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
        wrap.append(buildAudioPlayer(url));
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
    } else if (isFileMessage(msg, opts) && msg.mediaIds?.length) {
      const wrap = document.createElement("div");
      wrap.className = "bubble__file";
      const mid = msg.mediaIds[0];
      const info = msg.mediaInfo?.[0];
      const size = Number(info?.size) || 0;
      const outgoing = msg.senderPeerId === selfPeerId;
      const mime = info?.mime;
      const fileName = info?.fileName || "File";
      const url =
        typeof opts.getPlayableMediaUrl === "function"
          ? opts.getPlayableMediaUrl(mid, { size, mime, outgoing })
          : typeof opts.getMediaUrl === "function"
            ? opts.getMediaUrl(mid)
            : null;
      const needsDownload =
        !outgoing && size > VIDEO_AUTO_DOWNLOAD_BYTES && !url;
      const iconKind = fileIconKind(mime, fileName);
      if (url) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "file-doc";
        btn.innerHTML = `<span class="file-doc__icon file-doc__icon--${iconKind}"></span><span class="file-doc__meta"><span class="file-doc__name"></span><span class="file-doc__size"></span></span>`;
        const nameEl = btn.querySelector(".file-doc__name");
        const sizeEl = btn.querySelector(".file-doc__size");
        if (nameEl) nameEl.textContent = middleTruncate(fileName, 32);
        if (sizeEl) sizeEl.textContent = size ? formatBytes(size) : "";
        btn.title = fileName;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          a.target = "_blank";
          a.rel = "noopener";
          a.click();
        });
        wrap.append(btn);
      } else if (needsDownload || size > VIDEO_AUTO_DOWNLOAD_BYTES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "video-download file-download";
        btn.innerHTML = `<span class="file-doc__icon file-doc__icon--${iconKind}"></span><span class="video-download__label">Download file</span><span class="video-download__size"></span><span class="file-download__name"></span>`;
        const sizeEl = btn.querySelector(".video-download__size");
        const nameEl = btn.querySelector(".file-download__name");
        if (sizeEl) sizeEl.textContent = size ? formatBytes(size) : "";
        if (nameEl) nameEl.textContent = middleTruncate(fileName, 32);
        btn.title = fileName;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onDownloadMedia?.(mid);
        });
        wrap.append(btn);
      } else {
        const ph = document.createElement("div");
        ph.className = "file-doc file-doc--loading";
        ph.innerHTML = `<span class="file-doc__icon file-doc__icon--${iconKind}"></span><span class="file-doc__meta"><span class="file-doc__name"></span><span class="file-doc__size"></span></span>`;
        const nameEl = ph.querySelector(".file-doc__name");
        const sizeEl = ph.querySelector(".file-doc__size");
        if (nameEl) nameEl.textContent = middleTruncate(fileName, 32);
        if (sizeEl) {
          sizeEl.textContent = size
            ? `File… ${formatBytes(size)}`
            : "File…";
        }
        wrap.append(ph);
      }
      bubble.append(wrap);
      bubble.classList.add("bubble--file");
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
            opts.onOpenMedia?.(mid, msg.id);
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
        msg.kind === "file" ||
        isVideoMessage(msg, opts) ||
        isAudioMessage(msg, opts) ||
        isFileMessage(msg, opts))
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

    if (msg.reactions?.length) {
      const rowReact = document.createElement("div");
      rowReact.className = "bubble__reactions";
      for (const r of msg.reactions) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className =
          "reaction-chip" +
          (r.peerIds?.includes(selfPeerId) ? " is-mine" : "");
        chip.append(emojiImg(r.emoji));
        const count = document.createElement("span");
        count.className = "reaction-chip__count";
        count.textContent = String(r.peerIds?.length || 0);
        chip.append(count);
        chip.disabled = Boolean(opts.sessionEnded) || !opts.onReact;
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          opts.onReact?.(msg.id, r.emoji);
        });
        rowReact.append(chip);
      }
      bubble.append(rowReact);
    }

    // —— Interactions: right-click (desktop) / long-press (touch) open a
    // Telegram-style context menu instead of a hover toolbar. ——
    const canReact =
      !opts.sessionEnded && typeof opts.onReact === "function";
    const buildActions = () => {
      /** @type {{ label: string, danger?: boolean, onClick: () => void }[]} */
      const actions = [];
      if (!opts.sessionEnded && typeof opts.onReply === "function") {
        actions.push({ label: "Reply", onClick: () => opts.onReply(msg.id) });
      }
      if (msg.kind === "text" && msg.text) {
        actions.push({ label: "Copy", onClick: () => copyText(msg.text) });
      }
      if (!opts.sessionEnded && typeof opts.onForward === "function") {
        actions.push({
          label: "Forward",
          onClick: () => opts.onForward(msg.id),
        });
      }
      if (
        msg.kind === "sticker" &&
        msg.sticker &&
        typeof opts.onRefetchSticker === "function"
      ) {
        actions.push({
          label: "Re-fetch via peer",
          onClick: () =>
            opts.onRefetchSticker(
              msg.sticker.pack,
              msg.sticker.stickerId,
              msg.senderPeerId,
            ),
        });
      }
      if (
        !opts.sessionEnded &&
        outgoing &&
        msg.kind === "text" &&
        typeof opts.onEdit === "function"
      ) {
        actions.push({ label: "Edit", onClick: () => opts.onEdit(msg.id) });
      }
      const canDelete =
        !opts.sessionEnded &&
        typeof opts.onDeleteMessage === "function" &&
        (kind === "dm" ? outgoing : opts.isHost || outgoing);
      if (canDelete) {
        actions.push({
          label: "Delete",
          danger: true,
          onClick: () => opts.onDeleteMessage(msg.id),
        });
      }
      return actions;
    };
    const openMenuAt = (px, py) => {
      const actions = buildActions();
      if (!actions.length && !canReact) return;
      openContextMenu(px, py, {
        reactions: canReact ? REACTION_EMOJIS : null,
        onReact: canReact ? (emoji) => opts.onReact(msg.id, emoji) : null,
        actions,
      });
    };

    attachContextTrigger(bubble, openMenuAt);

    for (const el of bubble.querySelectorAll(".bubble__text")) {
      twemojify(el);
    }

    row.append(bubble);
    return row;
  }
}

/**
 * When rebuilding a row, keep a currently-playing <video>/<audio> element alive by
 * transplanting the same DOM node into the freshly built row (moving a node does not
 * reset media playback), so network-driven repaints never interrupt playback.
 * @param {HTMLElement} oldRow
 * @param {HTMLElement} newRow
 */
function preservePlayingMedia(oldRow, newRow) {
  const oldMedia = oldRow.querySelector("video, audio");
  if (!oldMedia) return;
  const live =
    !oldMedia.paused || oldMedia.currentTime > 0 || oldMedia.seeking;
  if (!live) return;
  // Audio has custom controls wired to this specific element, so transplant
  // the whole player container to keep the UI in sync. Video's controls live
  // on the element itself, so moving just the element suffices.
  if (oldMedia.tagName === "AUDIO") {
    const oldWrap = oldMedia.closest(".bubble__audio");
    const newWrap = newRow.querySelector(".bubble__audio");
    if (oldWrap && newWrap) {
      newWrap.replaceWith(oldWrap);
      return;
    }
  }
  const newMedia = newRow.querySelector(oldMedia.tagName.toLowerCase());
  if (newMedia && newMedia.src === oldMedia.src) {
    newMedia.replaceWith(oldMedia);
  }
}

/** @param {number} sec */
function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Custom audio player: a hidden <audio> plus a play/pause button, a wide
 * draggable seek bar, and current/duration time labels.
 * @param {string} url
 * @returns {HTMLElement}
 */
function buildAudioPlayer(url) {
  const PLAY =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const PAUSE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

  const player = document.createElement("div");
  player.className = "audio-player";

  const audio = document.createElement("audio");
  audio.className = "media-audio";
  audio.src = url;
  audio.preload = "metadata";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "audio-player__btn";
  btn.setAttribute("aria-label", "Play");
  btn.innerHTML = PLAY;

  const body = document.createElement("div");
  body.className = "audio-player__body";

  const seek = document.createElement("input");
  seek.type = "range";
  seek.className = "audio-player__seek";
  seek.min = "0";
  seek.max = "100";
  seek.step = "0.1";
  seek.value = "0";

  const times = document.createElement("div");
  times.className = "audio-player__times";
  const cur = document.createElement("span");
  cur.className = "audio-player__time";
  cur.textContent = "0:00";
  const dur = document.createElement("span");
  dur.className = "audio-player__time";
  dur.textContent = "0:00";
  times.append(cur, dur);

  body.append(seek, times);
  player.append(btn, audio, body);

  let dragging = false;
  const setFill = () => {
    const max = Number(seek.max) || 1;
    const pct = (Number(seek.value) / max) * 100;
    seek.style.setProperty("--seek", `${pct}%`);
  };

  btn.addEventListener("click", () => {
    if (audio.paused) audio.play();
    else audio.pause();
  });
  audio.addEventListener("play", () => {
    btn.innerHTML = PAUSE;
    btn.setAttribute("aria-label", "Pause");
  });
  audio.addEventListener("pause", () => {
    btn.innerHTML = PLAY;
    btn.setAttribute("aria-label", "Play");
  });
  // Blob/streamed audio often reports duration = Infinity at loadedmetadata and
  // only resolves the real value later via durationchange, so handle both.
  const applyDuration = () => {
    if (isFinite(audio.duration) && audio.duration > 0) {
      seek.max = String(audio.duration);
      dur.textContent = formatDuration(audio.duration);
      setFill();
    }
  };
  audio.addEventListener("loadedmetadata", applyDuration);
  audio.addEventListener("durationchange", applyDuration);
  audio.addEventListener("timeupdate", () => {
    if (dragging) return;
    seek.value = String(audio.currentTime);
    cur.textContent = formatDuration(audio.currentTime);
    setFill();
  });
  audio.addEventListener("ended", () => {
    btn.innerHTML = PLAY;
    btn.setAttribute("aria-label", "Play");
    seek.value = "0";
    cur.textContent = "0:00";
    setFill();
  });
  seek.addEventListener("pointerdown", () => {
    dragging = true;
  });
  seek.addEventListener("input", () => {
    cur.textContent = formatDuration(Number(seek.value));
    setFill();
  });
  seek.addEventListener("change", () => {
    audio.currentTime = Number(seek.value);
    dragging = false;
  });

  setFill();
  return player;
}

/**
 * Three-dot (kebab) chat-header menu holding group actions.
 * @param {{ label: string, danger?: boolean, onClick: () => void }[]} items
 * @returns {HTMLElement}
 */
function buildHeaderMenu(items) {
  const wrap = document.createElement("div");
  wrap.className = "chat-header__menu-wrap";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn chat-header__menu-btn";
  btn.setAttribute("aria-label", "Chat options");
  btn.title = "Chat options";
  btn.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';

  const menu = document.createElement("div");
  menu.className = "chat-header__menu";
  menu.hidden = true;

  const onDocClick = (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeMenu();
  };
  function closeMenu() {
    menu.hidden = true;
    btn.classList.remove("is-active");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  }

  for (const item of items) {
    const mi = document.createElement("button");
    mi.type = "button";
    mi.className = "menu-item" + (item.danger ? " menu-item--danger" : "");
    mi.textContent = item.label;
    mi.addEventListener("click", (e) => {
      e.stopPropagation();
      closeMenu();
      item.onClick();
    });
    menu.append(mi);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.classList.toggle("is-active", open);
    if (open) {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    } else {
      closeMenu();
    }
  });

  wrap.append(btn, menu);
  return wrap;
}

function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable */
  }
}

/** @type {{ el: HTMLElement, cleanup: () => void } | null} */
let activeMsgMenu = null;

function closeMessageMenu() {
  if (!activeMsgMenu) return;
  activeMsgMenu.cleanup();
  activeMsgMenu.el.remove();
  activeMsgMenu = null;
}

/**
 * Wire right-click (desktop) + long-press (touch) on an element to open a menu.
 * On touch, a fired long-press suppresses the following click (so it doesn't
 * also select the chat / trigger the bubble's default tap action).
 * @param {HTMLElement} el
 * @param {(x: number, y: number) => void} openAt
 */
function attachContextTrigger(el, openAt) {
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openAt(e.clientX, e.clientY);
  });

  let lpTimer = null;
  let lpFired = false;
  const clearLp = () => {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  };
  el.addEventListener(
    "touchstart",
    (e) => {
      lpFired = false;
      const t = e.touches[0];
      const cx = t ? t.clientX : 0;
      const cy = t ? t.clientY : 0;
      clearLp();
      lpTimer = setTimeout(() => {
        lpFired = true;
        openAt(cx, cy);
      }, 450);
    },
    { passive: true },
  );
  el.addEventListener("touchmove", clearLp, { passive: true });
  el.addEventListener("touchend", (e) => {
    clearLp();
    if (lpFired) e.preventDefault();
  });
  el.addEventListener("touchcancel", clearLp);
  el.addEventListener("click", (e) => {
    if (lpFired) {
      e.preventDefault();
      e.stopPropagation();
      lpFired = false;
    }
  });
}

/**
 * Telegram-style floating context menu: an optional reaction strip (quick emojis
 * + a "+" that expands to the full emoji grid) plus an action list. Used for both
 * message bubbles and chat-list items.
 * @param {number} x
 * @param {number} y
 * @param {{
 *   reactions?: string[] | null,
 *   onReact?: ((emoji: string) => void) | null,
 *   actions: { label: string, danger?: boolean, onClick: () => void }[],
 * }} config
 */
function openContextMenu(x, y, config) {
  closeMessageMenu();

  const menu = document.createElement("div");
  menu.className = "msg-context-menu";

  const reposition = () => {
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw - 8) nx = vw - rect.width - 8;
    if (ny + rect.height > vh - 8) ny = vh - rect.height - 8;
    menu.style.left = Math.max(8, nx) + "px";
    menu.style.top = Math.max(8, ny) + "px";
  };

  const react = (emoji) => {
    const fn = config.onReact;
    closeMessageMenu();
    fn?.(emoji);
  };

  if (config.onReact && config.reactions?.length) {
    const strip = document.createElement("div");
    strip.className = "ctx-reactions";
    for (const emoji of config.reactions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctx-reaction-btn";
      b.append(emojiImg(emoji));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        react(emoji);
      });
      strip.append(b);
    }
    const more = document.createElement("button");
    more.type = "button";
    more.className = "ctx-reaction-btn ctx-reaction-more";
    more.setAttribute("aria-label", "More reactions");
    more.textContent = "+";
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      strip.remove();
      const grid = document.createElement("div");
      grid.className = "ctx-emoji-grid";
      for (const emoji of EMOJI) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ctx-emoji";
        b.append(emojiImg(emoji));
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          react(emoji);
        });
        grid.append(b);
      }
      menu.prepend(grid);
      reposition();
    });
    strip.append(more);
    menu.append(strip);
  }

  if (config.actions.length) {
    const list = document.createElement("div");
    list.className = "ctx-actions";
    for (const a of config.actions) {
      const mi = document.createElement("button");
      mi.type = "button";
      mi.className = "menu-item" + (a.danger ? " menu-item--danger" : "");
      mi.textContent = a.label;
      mi.addEventListener("click", (e) => {
        e.stopPropagation();
        const fn = a.onClick;
        closeMessageMenu();
        fn();
      });
      list.append(mi);
    }
    menu.append(list);
  }

  document.body.append(menu);
  reposition();

  const onDocDown = (e) => {
    if (!menu.contains(e.target)) closeMessageMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") closeMessageMenu();
  };
  const onScroll = (e) => {
    if (e.target && e.target.nodeType && menu.contains(e.target)) return;
    closeMessageMenu();
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("contextmenu", onDocDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
  }, 0);

  activeMsgMenu = {
    el: menu,
    cleanup() {
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("contextmenu", onDocDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    },
  };
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

/**
 * Document bubble (kind file, or media with non-AV mime / fileName).
 * @param {import("../engine.js").Message | undefined} msg
 * @param {{ getMediaMime?: (mediaId: string) => string | null }} [opts]
 */
function isFileMessage(msg, opts = {}) {
  if (!msg?.mediaIds?.length) return false;
  if (msg.kind === "file") return true;
  if (msg.kind !== "media" || msg.mediaIds.length !== 1) return false;
  if (msg.mediaInfo?.[0]?.fileName) return true;
  const mid = msg.mediaIds[0];
  const fromInfo = msg.mediaInfo?.[0]?.mime;
  const fromStore =
    typeof opts.getMediaMime === "function" ? opts.getMediaMime(mid) : null;
  const mime = String(fromInfo || fromStore || "").toLowerCase();
  if (!mime) return false;
  return (
    !mime.startsWith("image/") &&
    !mime.startsWith("video/") &&
    !mime.startsWith("audio/")
  );
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
  if (msg.kind === "file" || isFileMessage(msg)) {
    return msg.text?.trim() || msg.mediaInfo?.[0]?.fileName || "File";
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

/**
 * Human day label for a date-separator pill: "Today" / "Yesterday" / localized date.
 * @param {number} ts
 */
function formatDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayMs = 86400000;
  const diffDays = Math.round((startOf(today) - startOf(d)) / dayMs);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  try {
    const sameYear = d.getFullYear() === today.getFullYear();
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "long",
      ...(sameYear ? {} : { year: "numeric" }),
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

/** @param {number} ts */
function buildDateSeparator(ts) {
  const wrap = document.createElement("div");
  wrap.className = "date-sep";
  const pill = document.createElement("span");
  pill.className = "date-sep__pill";
  pill.textContent = formatDayLabel(ts);
  wrap.append(pill);
  return wrap;
}
