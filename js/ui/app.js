import {
  applyDm,
  applyHost,
  assertHostExcludesDms,
  buildForwardedMessage,
  findMessage,
  getChatThread,
  isHostPeer,
  listChatsForUi,
} from "../engine.js";
import { parseMarkdownLite, toMarkdownLite } from "../entities.js";
import { MAX_ALBUM_ITEMS, VIDEO_AUTO_DOWNLOAD_BYTES } from "../constants.js";
import { buildFixture } from "../fixture.js";
import {
  isFixtureMode,
  readJoinHostPeerId,
  readJoinSessionId,
  readPermanentRoomId,
} from "../invite.js";
import { log } from "../log.js";
import {
  captureVideoThumbDataUrl,
  compressImage,
  formatBytes,
  isDeferredPlayableSize,
  isDeferredTransferMime,
  middleTruncate,
  mintMediaId,
  prepareAudio,
  prepareFile,
  prepareVideo,
} from "../media.js";
import {
  isMuted,
  loadPrefs,
  loadUiPrefs,
  saveUiPrefs,
  toggleMuted,
  togglePinned,
} from "../prefs.js";
import {
  clearResume,
  loadResume,
  remapDmPeer,
  saveResume,
} from "../resume.js";
import { selfCheckEnvelope } from "../protocol.js";
import { ChatSession } from "../session.js";
import {
  addPacks,
  ensureFixturePacks,
  fetchPack,
  getPack,
  stickerFileUrl,
} from "../stickers.js";
import { addPacksFromText, createPicker } from "./picker.js";
import { renderChatList, renderThread } from "./render.js";

const els = {
  landing: document.querySelector("#landing"),
  landingForm: document.querySelector("#landing-form"),
  landingName: document.querySelector("#landing-name"),
  landingRoom: document.querySelector("#landing-room"),
  landingRoomField: document.querySelector("#landing-room-field"),
  landingTitle: document.querySelector("#landing-title"),
  landingTitleField: document.querySelector("#landing-title-field"),
  landingPassword: document.querySelector("#landing-password"),
  landingPasswordField: document.querySelector("#landing-password-field"),
  landingJoinHint: document.querySelector("#landing-join-hint"),
  landingSubmit: document.querySelector("#landing-submit"),
  app: document.querySelector("#app"),
  chatList: document.querySelector("#chat-list"),
  chatHeader: document.querySelector("#chat-header"),
  messages: document.querySelector("#messages"),
  composeForm: document.querySelector("#compose-form"),
  composeInput: document.querySelector("#compose-input"),
  composeSend: document.querySelector("#compose-send"),
  bootBanner: document.querySelector("#boot-banner"),
  sessionLabel: document.querySelector("#session-label"),
  modeBadge: document.querySelector("#mode-badge"),
  connStatus: document.querySelector("#conn-status"),
  inviteBox: document.querySelector("#invite-box"),
  inviteUrl: document.querySelector("#invite-url"),
  inviteCopy: document.querySelector("#invite-copy"),
  btnNewDm: document.querySelector("#btn-new-dm"),
  btnNewGroup: document.querySelector("#btn-new-group"),
  btnAdmin: document.querySelector("#btn-admin"),
  btnRename: document.querySelector("#btn-rename"),
  btnEndSession: document.querySelector("#btn-end-session"),
  menuToggle: document.querySelector("#menu-toggle"),
  sidebarMenu: document.querySelector("#sidebar-menu"),
  collapseToggle: document.querySelector("#collapse-toggle"),
  chatSearch: document.querySelector("#chat-search"),
  sidebarResize: document.querySelector("#sidebar-resize"),
  rosterHint: document.querySelector("#roster-hint"),
  modal: document.querySelector("#modal"),
  modalTitle: document.querySelector("#modal-title"),
  modalBody: document.querySelector("#modal-body"),
  modalCancel: document.querySelector("#modal-cancel"),
  modalOk: document.querySelector("#modal-ok"),
  replyBar: document.querySelector("#reply-bar"),
  replyBarName: document.querySelector("#reply-bar-name"),
  replyBarText: document.querySelector("#reply-bar-text"),
  replyBarClear: document.querySelector("#reply-bar-clear"),
  editBar: document.querySelector("#edit-bar"),
  editBarClear: document.querySelector("#edit-bar-clear"),
  jumpFab: document.querySelector("#jump-fab"),
  picker: document.querySelector("#picker"),
  pickerToggle: document.querySelector("#picker-toggle"),
  attachBtn: document.querySelector("#attach-btn"),
  attachInput: document.querySelector("#attach-input"),
  attachPending: document.querySelector("#attach-pending"),
  uploadStatus: document.querySelector("#upload-status"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImg: document.querySelector("#lightbox-img"),
  lightboxPrev: document.querySelector("#lightbox-prev"),
  lightboxNext: document.querySelector("#lightbox-next"),
  lightboxClose: document.querySelector("#lightbox-close"),
  lightboxCounter: document.querySelector("#lightbox-counter"),
};

/** @type {"fixture" | "online" | null} */
let mode = null;
/** @type {ChatSession | null} */
let session = null;
/** @type {{ selfPeerId: string, hostState: import("../engine.js").HostState, dmState: import("../engine.js").DmState, media?: Map<string, import("../session.js").MediaEntry | { blob: Blob, mime: string, size: number, width?: number, height?: number, senderPeerId: string, objectUrl?: string }> } | null} */
let fixtureStore = null;
/** @type {{ file: File, url: string }[]} */
let pendingFiles = [];
/** @type {boolean} */
let sendingMedia = false;
/** @type {string | null} */
let activeChatId = null;
/** @type {null | (() => void)} */
let modalConfirm = null;
/** @type {string | null} */
let replyToId = null;
/** @type {{ chatId: string, messageId: string } | null} */
let editing = null;
/** @type {{ known: Set<string>, at: number } | null} */
let pendingGroupSelect = null;
/** @type {string} */
let chatFilter = "";
/** @type {Record<string, number>} */
const unread = Object.create(null);
/** @type {Map<string, Set<string>>} */
const seenMessageIds = new Map();

const joinId = readJoinSessionId();
const joinHostId = readJoinHostPeerId();
const permanentRoomId = readPermanentRoomId();
log("boot", {
  href: location.href,
  joinId,
  permanentRoomId,
  fixture: isFixtureMode(),
  build: "phase7-polish",
});

const picker = createPicker(els.picker, {
  onEmoji: (emoji) => insertAtCursor(els.composeInput, emoji),
  onSticker: (ref) => sendSticker(ref),
  onRequestAddPacks: () => openAddPacksModal(),
});

function getStore() {
  if (mode === "fixture" && fixtureStore) return fixtureStore;
  if (session?.hostState) {
    return {
      selfPeerId: session.selfPeerId,
      hostState: session.hostState,
      dmState: session.dmState,
    };
  }
  return null;
}

function showBanner(text, ok) {
  if (!els.bootBanner) return;
  els.bootBanner.hidden = false;
  els.bootBanner.className =
    "boot-banner " + (ok ? "boot-banner--ok" : "boot-banner--err");
  els.bootBanner.textContent = text;
  if (ok) {
    setTimeout(() => {
      els.bootBanner.hidden = true;
    }, 4000);
  }
}

function currentSessionId() {
  const store = getStore();
  return store?.hostState?.session?.id || "";
}

function trackUnread(store) {
  const sid = store.hostState?.session?.id || "";
  const chats = listChatsForUi(
    store.hostState,
    store.dmState,
    store.selfPeerId,
  );
  for (const chat of chats) {
    if (sid && isMuted(sid, chat.id)) continue;
    const thread = getChatThread(store.hostState, store.dmState, chat.id);
    if (!thread) continue;
    let seen = seenMessageIds.get(chat.id);
    if (!seen) {
      seen = new Set(thread.messages.map((m) => m.id));
      seenMessageIds.set(chat.id, seen);
      continue;
    }
    for (const msg of thread.messages) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
      if (chat.id === activeChatId) continue;
      if (msg.senderPeerId === store.selfPeerId) continue;
      unread[chat.id] = (unread[chat.id] || 0) + 1;
    }
  }
}

function clearReply() {
  replyToId = null;
  if (els.replyBar) els.replyBar.hidden = true;
}

function clearEdit() {
  editing = null;
  if (els.editBar) els.editBar.hidden = true;
  els.composeSend.setAttribute("aria-label", "Send");
}

function setReply(messageId) {
  const store = getStore();
  if (!store || !activeChatId) return;
  clearEdit();
  const msg = findMessage(
    store.hostState,
    store.dmState,
    activeChatId,
    messageId,
  );
  if (!msg) return;
  replyToId = messageId;
  const sender = store.hostState.roster.find((r) => r.peerId === msg.senderPeerId);
  els.replyBarName.textContent =
    msg.senderPeerId === store.selfPeerId
      ? "You"
      : sender?.displayName || msg.senderPeerId || "Message";
  const mime = msg.mediaIds?.[0]
    ? resolveMediaMime(msg.mediaIds[0]) || msg.mediaInfo?.[0]?.mime
    : null;
  const mimeLc = String(mime || "").toLowerCase();
  const asVideo =
    msg.kind === "video" ||
    (msg.kind === "media" &&
      msg.mediaIds?.length === 1 &&
      mimeLc.startsWith("video/"));
  const asAudio =
    msg.kind === "audio" ||
    (msg.kind === "media" &&
      msg.mediaIds?.length === 1 &&
      mimeLc.startsWith("audio/"));
  const asFile =
    msg.kind === "file" ||
    (msg.kind === "media" &&
      msg.mediaIds?.length === 1 &&
      (Boolean(msg.mediaInfo?.[0]?.fileName) ||
        (mimeLc &&
          !mimeLc.startsWith("image/") &&
          !mimeLc.startsWith("video/") &&
          !mimeLc.startsWith("audio/"))));
  els.replyBarText.textContent =
    msg.kind === "sticker"
      ? "Sticker"
      : asVideo
        ? msg.text?.trim() || "Video"
        : asAudio
          ? msg.text?.trim() || "Audio"
          : asFile
            ? msg.text?.trim() || msg.mediaInfo?.[0]?.fileName || "File"
            : msg.kind === "media"
              ? msg.text?.trim() || "Photo"
              : msg.kind === "album"
                ? msg.text?.trim() || "Album"
                : msg.text || "";
  els.replyBar.hidden = false;
  els.composeInput.focus();
}

function setEdit(messageId) {
  const store = getStore();
  if (!store || !activeChatId) return;
  clearReply();
  const msg = findMessage(
    store.hostState,
    store.dmState,
    activeChatId,
    messageId,
  );
  if (!msg || msg.senderPeerId !== store.selfPeerId) return;
  editing = { chatId: activeChatId, messageId };
  // Restore markers so save via parseMarkdownLite keeps formatting
  els.composeInput.value = toMarkdownLite(msg.text || "", msg.entities);
  els.editBar.hidden = false;
  els.composeSend.setAttribute("aria-label", "Save");
  els.composeInput.focus();
}

function updateJumpFab() {
  const el = els.messages;
  if (!el || !els.jumpFab) return;
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  els.jumpFab.hidden = dist < 100;
}

function paint() {
  const store = getStore();
  if (!store) {
    if (els.sessionLabel && mode === "online" && session?.role === "guest") {
      els.sessionLabel.textContent = "Joining…";
    }
    els.btnNewDm && (els.btnNewDm.disabled = true);
    els.btnNewGroup && (els.btnNewGroup.disabled = true);
    els.composeInput && (els.composeInput.disabled = true);
    els.composeSend && (els.composeSend.disabled = true);
    return;
  }

  trackUnread(store);

  // Guest creator: auto-open the group we just created once it arrives from host.
  if (pendingGroupSelect && store.hostState?.groups) {
    const found = Object.values(store.hostState.groups).find(
      (g) =>
        g.createdBy === store.selfPeerId &&
        !pendingGroupSelect.known.has(g.id),
    );
    if (found) {
      activeChatId = found.id;
      unread[found.id] = 0;
      clearReply();
      clearEdit();
      pendingGroupSelect = null;
    } else if (Date.now() - pendingGroupSelect.at > 15000) {
      pendingGroupSelect = null;
    }
  }

  const ended = mode === "online" ? session?.sessionEnded : false;
  const asHost =
    mode === "online"
      ? session?.role === "host"
      : isHostPeer(store.hostState, store.selfPeerId);

  const sid = store.hostState?.session?.id || "";
  const prefs = loadPrefs(sid);
  let chats = listChatsForUi(
    store.hostState,
    store.dmState,
    store.selfPeerId,
  );
  chats = [...chats].sort((a, b) => {
    const ap = prefs.pinnedChatIds.includes(a.id) ? 1 : 0;
    const bp = prefs.pinnedChatIds.includes(b.id) ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.updatedAt - a.updatedAt;
  });
  if (activeChatId && !chats.some((c) => c.id === activeChatId)) {
    activeChatId = null;
    clearReply();
    clearEdit();
  }

  if (els.app) {
    els.app.classList.toggle("app--chat-open", Boolean(activeChatId));
  }

  const q = chatFilter.trim().toLowerCase();
  const visibleChats = q
    ? chats.filter(
        (c) =>
          (c.title || "").toLowerCase().includes(q) ||
          (c.preview || "").toLowerCase().includes(q),
      )
    : chats;

  renderChatList(
    els.chatList,
    visibleChats,
    activeChatId,
    unread,
    (id) => {
      activeChatId = id;
      unread[id] = 0;
      clearReply();
      clearEdit();
      paint();
    },
    {
      pinnedIds: prefs.pinnedChatIds,
      mutedIds: prefs.mutedChatIds,
      emptyHint: store.hostState.roster.length
        ? "No chats yet — start a DM or group"
        : "Share the invite so people can join",
      onTogglePin: (chatId) => {
        togglePinned(sid, chatId);
        paint();
      },
      onToggleMute: (chatId) => {
        toggleMuted(sid, chatId);
        paint();
      },
    },
  );

  const thread = activeChatId
    ? getChatThread(store.hostState, store.dmState, activeChatId)
    : null;

  renderThread(
    els.chatHeader,
    els.messages,
    thread,
    store.selfPeerId,
    store.hostState,
    {
      isHost: asHost,
      sessionEnded: ended,
      subtitle:
        mode === "fixture" ? "Fixture mode — no network" : "Online session",
      onDeleteGroup: () => {
        if (mode === "online" && session && activeChatId) {
          session.dispatchHostAction({
            type: "delete-group",
            chatId: activeChatId,
          });
        }
      },
      onAddMembers: () => openAddMembersModal(),
      onDeleteMessage: (messageId) => {
        if (!activeChatId) return;
        if (mode === "online" && session) {
          const t = getChatThread(
            store.hostState,
            store.dmState,
            activeChatId,
          );
          if (t?.kind === "group") {
            session.dispatchHostAction({
              type: "delete-message",
              chatId: activeChatId,
              messageId,
            });
          } else {
            session.deleteDmMessage(activeChatId, messageId);
          }
        } else if (mode === "fixture" && fixtureStore) {
          const t = getChatThread(
            fixtureStore.hostState,
            fixtureStore.dmState,
            activeChatId,
          );
          if (t?.kind === "group") {
            const r = applyHost(
              fixtureStore.hostState,
              {
                type: "delete-message",
                chatId: activeChatId,
                messageId,
              },
              { actorPeerId: fixtureStore.selfPeerId },
            );
            if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
          } else {
            const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
              type: "dm-delete",
              dmId: activeChatId,
              messageId,
            });
            if (r.ok) fixtureStore = { ...fixtureStore, dmState: r.state };
          }
          paint();
        }
      },
      onReply: (messageId) => setReply(messageId),
      onEdit: (messageId) => setEdit(messageId),
      onReact: (messageId, emoji) => reactToMessage(messageId, emoji),
      onForward: (messageId) => openForwardModal(messageId),
      onOpenStickerPack: (ref) => openStickerPackModal(ref),
      onBack: () => {
        activeChatId = null;
        clearReply();
        clearEdit();
        paint();
      },
      getMediaUrl: (mediaId) => resolveMediaUrl(mediaId),
      getPlayableMediaUrl: (mediaId, gate) =>
        resolvePlayableMediaUrl(mediaId, gate),
      getMediaMime: (mediaId) => resolveMediaMime(mediaId),
      onOpenMedia: (mediaId, messageId) =>
        openLightboxGallery(mediaId, messageId),
      onDownloadMedia: (mediaId) => {
        if (mode === "online" && session) {
          session.unlockMedia(mediaId);
          const meta = session.getMediaMeta(mediaId);
          const size = meta?.size ? formatBytes(meta.size) : "";
          setUploadStatus(
            size ? `Downloading… 0% · 0 B / ${size}` : "Downloading…",
          );
          session.ensureMedia([mediaId], {
            force: true,
            sizes: meta?.size != null ? { [mediaId]: meta.size } : undefined,
            mimes: meta?.mime ? { [mediaId]: meta.mime } : undefined,
            senders: meta?.senderPeerId
              ? { [mediaId]: meta.senderPeerId }
              : undefined,
          });
          paint();
        } else if (mode === "fixture") {
          unlockedFixtureMedia.add(mediaId);
          paint();
        }
      },
    },
  );

  // Pull missing media while viewing (large videos wait for tap → fetch from sender)
  if (mode === "online" && session && thread) {
    for (const msg of thread.messages) {
      if (!msg.mediaIds?.length) continue;
      session.rememberMediaInfo(msg);
      const sizes = Object.create(null);
      const mimes = Object.create(null);
      const senders = Object.create(null);
      msg.mediaIds.forEach((id, i) => {
        const sz = msg.mediaInfo?.[i]?.size;
        if (sz != null) sizes[id] = sz;
        const mime = msg.mediaInfo?.[i]?.mime;
        if (mime) mimes[id] = mime;
        if (msg.senderPeerId) senders[id] = msg.senderPeerId;
      });
      // Sender already has bytes; everyone else skips large AV until Download.
      if (msg.senderPeerId === store.selfPeerId) {
        msg.mediaIds.forEach((id) => session.unlockMedia(id));
      }
      session.ensureMedia(msg.mediaIds, { sizes, mimes, senders });
    }
    // Clear download status once blobs arrive
    if (
      els.uploadStatus &&
      !els.uploadStatus.hidden &&
      /Downloading/i.test(els.uploadStatus.textContent || "")
    ) {
      const waiting = thread.messages.some((m) => {
        if (!m.mediaIds?.length) return false;
        const mime =
          m.mediaInfo?.[0]?.mime || resolveMediaMime(m.mediaIds[0]);
        const mimeLc = String(mime || "").toLowerCase();
        const asDeferred =
          m.kind === "video" ||
          m.kind === "audio" ||
          m.kind === "file" ||
          (m.kind === "media" &&
            m.mediaIds.length === 1 &&
            isDeferredTransferMime(mimeLc));
        return asDeferred && m.mediaIds.some((id) => !resolveMediaUrl(id));
      });
      if (!waiting) setUploadStatus("");
    }
  }

  const canSend = Boolean(thread) && !ended && !sendingMedia;
  els.composeInput.disabled = !canSend;
  els.composeSend.disabled = !canSend;
  if (els.attachBtn) els.attachBtn.disabled = !canSend;
  const rosterOthers = store.hostState.roster.filter(
    (r) => r.peerId !== store.selfPeerId,
  );
  els.btnNewDm.disabled = ended || !rosterOthers.length;
  els.btnNewGroup.disabled = ended || rosterOthers.length < 1;
  if (els.rosterHint) {
    els.rosterHint.hidden = ended || rosterOthers.length > 0 || !asHost;
  }
  if (els.btnAdmin) {
    els.btnAdmin.hidden = !asHost || ended || mode === "fixture";
  }
  if (els.btnEndSession) {
    els.btnEndSession.hidden = !asHost || ended;
  }

  if (els.sessionLabel) {
    els.sessionLabel.textContent = store.hostState.session.title || "Session";
    els.sessionLabel.classList.toggle("is-editable", asHost && !ended);
    els.sessionLabel.title = asHost && !ended ? "Rename session" : "Session";
  }
  updateJumpFab();
}

let paintScheduled = false;
/**
 * Coalesce bursts of network-driven onChange events into a single repaint per frame,
 * so acks/presence/media-chunk traffic can't cause a storm of full repaints.
 */
function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => {
    paintScheduled = false;
    paint();
  });
}

function reactToMessage(messageId, emoji) {
  const store = getStore();
  if (!store || !activeChatId) return;
  const thread = getChatThread(
    store.hostState,
    store.dmState,
    activeChatId,
  );
  if (!thread) return;
  if (mode === "online" && session) {
    if (thread.kind === "group") {
      session.setGroupReaction(activeChatId, messageId, emoji);
    } else {
      session.setDmReaction(activeChatId, messageId, emoji);
    }
  } else if (mode === "fixture" && fixtureStore) {
    if (thread.kind === "group") {
      const r = applyHost(
        fixtureStore.hostState,
        {
          type: "set-reaction",
          chatId: activeChatId,
          messageId,
          emoji,
        },
        { actorPeerId: fixtureStore.selfPeerId },
      );
      if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    } else {
      const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
        type: "dm-reaction",
        dmId: activeChatId,
        messageId,
        emoji,
      });
      if (r.ok) fixtureStore = { ...fixtureStore, dmState: r.state };
    }
    paint();
  }
}

function openForwardModal(messageId) {
  const store = getStore();
  if (!store || !activeChatId) return;
  const src = findMessage(
    store.hostState,
    store.dmState,
    activeChatId,
    messageId,
  );
  if (!src || src.kind === "system") return;
  const fromChatId = activeChatId;
  const chats = listChatsForUi(
    store.hostState,
    store.dmState,
    store.selfPeerId,
  ).filter((c) => c.id !== fromChatId);

  openModal(
    "Forward to…",
    (body) => {
      if (!chats.length) {
        body.textContent = "No other chats to forward to.";
        return;
      }
      const list = document.createElement("div");
      list.className = "modal__list";
      for (const c of chats) {
        const label = document.createElement("label");
        label.className = "modal__check";
        label.innerHTML = `<input type="radio" name="fwd-target" value="${c.id}" data-kind="${c.kind}" /> <span></span>`;
        label.querySelector("span").textContent = `${c.title} (${c.kind})`;
        list.append(label);
      }
      body.append(list);
    },
    () => {
      const picked = els.modalBody.querySelector(
        'input[name="fwd-target"]:checked',
      );
      if (!picked) return;
      const toChatId = picked.value;
      const toKind = picked.getAttribute("data-kind");
      closeModal();
      doForward(src, fromChatId, toChatId, toKind);
    },
    "Forward",
  );
}

/**
 * @param {import("../engine.js").Message} src
 * @param {string} fromChatId
 * @param {string} toChatId
 * @param {string} toKind
 */
function doForward(src, fromChatId, toChatId, toKind) {
  const store = getStore();
  if (!store) return;
  const fromName =
    store.hostState.roster.find((r) => r.peerId === src.senderPeerId)
      ?.displayName || "Someone";
  const fromThread = getChatThread(
    store.hostState,
    store.dmState,
    fromChatId,
  );

  if (
    mode === "online" &&
    session &&
    fromThread?.kind === "group" &&
    toKind === "group"
  ) {
    session.forwardGroupMessage(fromChatId, src.id, toChatId, fromName);
    return;
  }

  const msg = buildForwardedMessage(src, {
    chatId: toChatId,
    senderPeerId: store.selfPeerId,
    fromName,
    fromPeerId: src.senderPeerId,
    fromChatId,
  });

  if (mode === "online" && session) {
    if (toKind === "dm") {
      session.forwardToDm(toChatId, msg);
    } else if (msg.kind === "sticker" && msg.sticker) {
      session.dispatchHostAction({
        type: "send-sticker",
        chatId: toChatId,
        pack: msg.sticker.pack,
        stickerId: msg.sticker.stickerId,
        forward: msg.forward,
      });
    } else if (msg.mediaIds?.length) {
      session.dispatchHostAction({
        type: "send-media",
        chatId: toChatId,
        mediaIds: msg.mediaIds,
        mediaInfo: msg.mediaInfo,
        mediaKind:
          msg.kind === "video" ||
          msg.kind === "audio" ||
          msg.kind === "file"
            ? msg.kind
            : undefined,
        text: msg.text,
        entities: msg.entities,
        forward: msg.forward,
      });
    } else {
      session.dispatchHostAction({
        type: "send-text",
        chatId: toChatId,
        text: msg.text || "(forwarded)",
        entities: msg.entities,
        forward: msg.forward,
      });
    }
    return;
  }

  if (mode === "fixture" && fixtureStore) {
    if (toKind === "group" && fromThread?.kind === "group") {
      const r = applyHost(
        fixtureStore.hostState,
        {
          type: "forward-message",
          fromChatId,
          messageId: src.id,
          toChatId,
          fromName,
        },
        { actorPeerId: fixtureStore.selfPeerId },
      );
      if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    } else if (toKind === "dm") {
      const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
        type: "dm-forward",
        dmId: toChatId,
        message: msg,
      });
      if (r.ok) fixtureStore = { ...fixtureStore, dmState: r.state };
    } else if (msg.kind === "text") {
      const r = applyHost(
        fixtureStore.hostState,
        {
          type: "send-text",
          chatId: toChatId,
          text: msg.text || "(forwarded)",
          forward: msg.forward,
        },
        { actorPeerId: fixtureStore.selfPeerId },
      );
      if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    }
    paint();
  }
}

function openAdminModal() {
  const store = getStore();
  if (!store) return;
  const others = store.hostState.roster.filter(
    (r) => r.peerId !== store.selfPeerId,
  );
  openModal(
    "Kick member",
    (body) => {
      if (!others.length) {
        body.textContent = "No other members to kick.";
        return;
      }
      const list = document.createElement("div");
      list.className = "modal__list";
      for (const r of others) {
        const label = document.createElement("label");
        label.className = "modal__check";
        label.innerHTML = `<input type="radio" name="kick-peer" value="${r.peerId}" /> <span></span>`;
        label.querySelector("span").textContent = r.displayName || r.peerId;
        list.append(label);
      }
      body.append(list);
    },
    () => {
      const picked = els.modalBody.querySelector(
        'input[name="kick-peer"]:checked',
      );
      if (!picked) return;
      const peerId = picked.value;
      closeModal();
      if (!confirm(`Remove ${peerId} from the session?`)) return;
      if (mode === "online" && session) session.kickPeer(peerId);
      else if (mode === "fixture" && fixtureStore) {
        const r = applyHost(
          fixtureStore.hostState,
          { type: "admin-kick", peerId },
          { actorPeerId: fixtureStore.selfPeerId },
        );
        if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
        paint();
      }
    },
    "Kick",
  );
}

function renameSessionPrompt() {
  const store = getStore();
  if (!store) return;
  const asHost =
    mode === "online"
      ? session?.role === "host"
      : isHostPeer(store.hostState, store.selfPeerId);
  if (!asHost) return;
  const next = prompt(
    "Session title",
    store.hostState.session.title || "Session",
  );
  if (next == null) return;
  const title = next.trim();
  if (!title) return;
  if (mode === "online" && session) session.renameSession(title);
  else if (mode === "fixture" && fixtureStore) {
    const r = applyHost(
      fixtureStore.hostState,
      { type: "admin-rename-session", title },
      { actorPeerId: fixtureStore.selfPeerId },
    );
    if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    paint();
  }
}

function enterAppShell({ badge, status, inviteUrl }) {
  els.landing.hidden = true;
  els.app.hidden = false;
  if (els.modeBadge) els.modeBadge.textContent = badge;
  if (els.connStatus) els.connStatus.textContent = status;
  if (inviteUrl && els.inviteBox && els.inviteUrl) {
    els.inviteBox.hidden = false;
    els.inviteUrl.value = inviteUrl;
  } else if (els.inviteBox) {
    els.inviteBox.hidden = true;
  }
}

async function startFixture() {
  mode = "fixture";
  enterAppShell({ badge: "Fixture", status: "Loading fixture…" });
  const pack = await ensureFixturePacks();
  fixtureStore = await buildFixture(pack);
  const privacy = assertHostExcludesDms(
    fixtureStore.hostState,
    fixtureStore.dmState,
  );
  const envOk = selfCheckEnvelope();
  showBanner(
    [
      envOk ? "envelope mode=none ok" : "envelope FAIL",
      privacy.ok ? "host snapshot excludes DMs" : privacy.error,
      `pack ${pack.name}`,
      `media ${fixtureStore.media?.size || 0}`,
    ].join(" · "),
    envOk && privacy.ok,
  );
  if (els.connStatus) els.connStatus.textContent = "Offline fixture";
  picker.refresh();
  paint();
}

/**
 * @param {HTMLTextAreaElement} input
 * @param {string} text
 */
function insertAtCursor(input, text) {
  if (!input || input.disabled) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const v = input.value;
  input.value = v.slice(0, start) + text + v.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.focus();
}

/**
 * @param {{ pack: string, stickerId: string, emoji?: string }} ref
 */
function sendSticker(ref) {
  if (!activeChatId) return;
  const store = getStore();
  if (!store) return;
  const thread = getChatThread(
    store.hostState,
    store.dmState,
    activeChatId,
  );
  if (!thread) return;
  const replyTo = replyToId || undefined;

  if (mode === "fixture" && fixtureStore) {
    if (thread.kind === "group") {
      const r = applyHost(
        fixtureStore.hostState,
        {
          type: "send-sticker",
          chatId: activeChatId,
          pack: ref.pack,
          stickerId: ref.stickerId,
          replyTo,
        },
        { actorPeerId: fixtureStore.selfPeerId },
      );
      if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    } else {
      const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
        type: "dm-send-sticker",
        dmId: activeChatId,
        pack: ref.pack,
        stickerId: ref.stickerId,
        replyTo,
      });
      if (r.ok) fixtureStore = { ...fixtureStore, dmState: r.state };
    }
    clearReply();
    paint();
    return;
  }

  if (session && !session.sessionEnded) {
    if (thread.kind === "group") {
      session.sendGroupSticker(activeChatId, {
        pack: ref.pack,
        stickerId: ref.stickerId,
        replyTo,
      });
    } else {
      session.sendDmSticker(activeChatId, {
        pack: ref.pack,
        stickerId: ref.stickerId,
        replyTo,
      });
    }
    clearReply();
  }
}

function openAddPacksModal() {
  openModal(
    "Add sticker packs",
    (body) => {
      const label = document.createElement("label");
      label.className = "field";
      label.innerHTML = `<span>Pack links or names (one per line)</span>`;
      const ta = document.createElement("textarea");
      ta.id = "pack-list-input";
      ta.rows = 5;
      ta.placeholder =
        "https://t.me/addstickers/TofPaintSafe\nAnotherPackName";
      ta.style.cssText =
        "width:100%;border:1px solid var(--border);border-radius:10px;padding:10px;font:inherit;resize:vertical";
      label.append(ta);
      body.append(label);
      const status = document.createElement("p");
      status.id = "pack-list-status";
      status.style.cssText =
        "font-size:12px;color:var(--text-secondary);margin:8px 0 0";
      body.append(status);
    },
    async () => {
      const ta = els.modalBody.querySelector("#pack-list-input");
      const status = els.modalBody.querySelector("#pack-list-status");
      const text = ta?.value || "";
      if (status) status.textContent = "Fetching…";
      els.modalOk.disabled = true;
      try {
        const result = await addPacksFromText(text);
        const parts = [];
        if (result.ok.length) parts.push(`Added: ${result.ok.join(", ")}`);
        for (const err of result.errors) {
          parts.push(`${err.input}: ${err.error}`);
        }
        if (status) status.textContent = parts.join(" · ") || "Nothing to add";
        if (result.ok.length) {
          picker.focusPack(result.ok);
          showBanner(`Packs: ${result.ok.join(", ")}`, true);
          closeModal();
        }
      } finally {
        els.modalOk.disabled = false;
      }
    },
  );
}

/** @type {((e: Event) => void) | null} */
let pickerOutsideHandler = null;
/** @type {((e: KeyboardEvent) => void) | null} */
let pickerKeyHandler = null;

function closePicker() {
  if (!els.picker || els.picker.hidden) return;
  els.picker.hidden = true;
  els.pickerToggle?.classList.remove("is-active");
  if (pickerOutsideHandler) {
    document.removeEventListener("pointerdown", pickerOutsideHandler, true);
    pickerOutsideHandler = null;
  }
  if (pickerKeyHandler) {
    document.removeEventListener("keydown", pickerKeyHandler, true);
    pickerKeyHandler = null;
  }
}

function togglePicker() {
  if (!els.picker || !els.pickerToggle) return;
  const open = els.picker.hidden;
  if (!open) {
    closePicker();
    return;
  }
  els.picker.hidden = false;
  els.pickerToggle.classList.add("is-active");
  picker.render();
  pickerOutsideHandler = (e) => {
    const target = /** @type {Node} */ (e.target);
    if (els.picker?.contains(target) || els.pickerToggle?.contains(target)) {
      return;
    }
    closePicker();
  };
  pickerKeyHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
    }
  };
  document.addEventListener("pointerdown", pickerOutsideHandler, true);
  document.addEventListener("keydown", pickerKeyHandler, true);
}

function closeSidebarMenu() {
  if (els.sidebarMenu) els.sidebarMenu.hidden = true;
  els.menuToggle?.classList.remove("is-active");
}

function toggleSidebarMenu() {
  if (!els.sidebarMenu) return;
  const open = els.sidebarMenu.hidden;
  els.sidebarMenu.hidden = !open;
  els.menuToggle?.classList.toggle("is-active", open);
}

/** @param {number} px */
function clampSidebarWidth(px) {
  return Math.max(240, Math.min(520, Math.round(px)));
}

/** @param {boolean} collapsed */
function setRail(collapsed) {
  els.app?.classList.toggle("app--rail", Boolean(collapsed));
  const path = els.collapseToggle?.querySelector("path");
  if (path) path.setAttribute("d", collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6");
  if (els.collapseToggle) {
    const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
    els.collapseToggle.title = label;
    els.collapseToggle.setAttribute("aria-label", label);
  }
}

function toggleRail() {
  const collapsed = !els.app?.classList.contains("app--rail");
  setRail(collapsed);
  saveUiPrefs({ sidebarCollapsed: collapsed });
  if (collapsed) closeSidebarMenu();
}

function applyUiPrefs() {
  const ui = loadUiPrefs();
  if (ui.sidebarWidth) {
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${clampSidebarWidth(ui.sidebarWidth)}px`,
    );
  }
  setRail(ui.sidebarCollapsed);
}

function initSidebarResize() {
  const handle = els.sidebarResize;
  if (!handle || !els.app) return;
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const left = els.app.getBoundingClientRect().left;
    const width = clampSidebarWidth(e.clientX - left);
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const w = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--sidebar-width",
      ),
      10,
    );
    if (Number.isFinite(w)) saveUiPrefs({ sidebarWidth: w });
  };
  handle.addEventListener("pointerdown", (e) => {
    if (els.app.classList.contains("app--rail")) return; // no resize while railed
    dragging = true;
    document.body.classList.add("is-resizing");
    e.preventDefault();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function persistResume() {
  if (mode !== "online" || !session) return;
  const snap = session.getResumeSnapshot();
  if (!snap?.sessionId) return;
  if (session.sessionEnded) {
    clearResume();
    return;
  }
  saveResume(snap);
}

/**
 * @param {string} displayName
 * @param {string} title
 * @param {import("../resume.js").ResumeBlob} [resume]
 * @param {string} [password]
 */
async function startOnlineHost(displayName, title, resume, password) {
  mode = "online";
  session = new ChatSession({
    onChange: () => {
      if (session?.sessionEnded) clearResume();
      else persistResume();
      schedulePaint();
    },
    onStatus: (s) => {
      if (els.connStatus) els.connStatus.textContent = s;
    },
    onError: (m) => showBanner(m, false),
    onProgress: (label) => setUploadStatus(label || ""),
  });
  enterAppShell({ badge: "Host", status: "Connecting…" });
  try {
    await session.createHost({
      displayName,
      title: title || resume?.title || "",
      sessionId: resume?.sessionId,
      restoreHostState: resume?.hostState,
      previousHostPeerId: resume?.previousHostPeerId,
      password: password ?? resume?.password,
    });
    if (resume?.dmState && resume.previousSelfPeerId) {
      session.dmState = remapDmPeer(
        resume.dmState,
        resume.previousSelfPeerId,
        session.selfPeerId,
      );
    }
    if (els.inviteBox && els.inviteUrl && session.inviteUrl) {
      els.inviteBox.hidden = false;
      els.inviteUrl.value = session.inviteUrl;
    }
    persistResume();
    paint();
  } catch (e) {
    showBanner(e?.message || String(e), false);
    els.connStatus.textContent = "Connection failed";
  }
}

/**
 * @param {string} displayName
 * @param {string} sessionId
 * @param {import("../resume.js").ResumeBlob} [resume]
 * @param {string} [password]
 */
async function startOnlineGuest(displayName, sessionId, resume, password) {
  mode = "online";
  session = new ChatSession({
    onChange: () => {
      if (session?.sessionEnded) clearResume();
      else persistResume();
      schedulePaint();
    },
    onStatus: (s) => {
      if (els.connStatus) els.connStatus.textContent = s;
    },
    onError: (m) => showBanner(m, false),
    onProgress: (label) => setUploadStatus(label || ""),
  });
  enterAppShell({ badge: "Guest", status: "Connecting…" });
  try {
    await session.joinGuest({
      displayName,
      sessionId,
      hostPeerId: joinHostId || resume?.hostPeerId || undefined,
      password: password ?? resume?.password,
    });
    if (resume?.dmState && resume.previousSelfPeerId) {
      session.dmState = remapDmPeer(
        resume.dmState,
        resume.previousSelfPeerId,
        session.selfPeerId,
      );
    }
    persistResume();
    paint();
  } catch (e) {
    showBanner(e?.message || String(e), false);
    els.connStatus.textContent = "Connection failed";
  }
}

/**
 * @param {string} displayName
 * @param {string} roomId
 * @param {import("../resume.js").ResumeBlob} [resume]
 * @param {string} [password]
 */
async function startPermanentRoom(displayName, roomId, resume, password) {
  mode = "online";
  session = new ChatSession({
    onChange: () => {
      if (session?.sessionEnded) clearResume();
      else persistResume();
      schedulePaint();
    },
    onStatus: (s) => {
      if (els.connStatus) els.connStatus.textContent = s;
      if (els.modeBadge && session) {
        els.modeBadge.textContent =
          session.role === "host"
            ? "Room host"
            : session.role === "candidate"
              ? "Room"
              : "Member";
      }
    },
    onError: (m) => showBanner(m, false),
    onProgress: (label) => setUploadStatus(label || ""),
  });
  enterAppShell({ badge: "Room", status: "Looking for room" });
  try {
    await session.enterPermanentRoom({
      displayName,
      roomId,
      resume,
      password: password ?? resume?.password,
    });
    if (els.inviteBox && els.inviteUrl && session.inviteUrl) {
      els.inviteBox.hidden = false;
      els.inviteUrl.value = session.inviteUrl;
    }
    persistResume();
    paint();
  } catch (e) {
    showBanner(e?.message || String(e), false);
    els.connStatus.textContent = "Connection failed";
  }
}

function openAddMembersModal() {
  const store = getStore();
  if (!store || !activeChatId) return;
  const thread = getChatThread(
    store.hostState,
    store.dmState,
    activeChatId,
  );
  if (!thread || thread.kind !== "group") return;
  const inGroup = new Set(thread.chat.memberPeerIds);
  const candidates = store.hostState.roster.filter(
    (r) => !inGroup.has(r.peerId),
  );
  if (!candidates.length) {
    showBanner("Everyone in the session is already in this group", false);
    return;
  }
  openModal(
    "Add members",
    (body) => {
      const list = document.createElement("div");
      list.className = "modal__list";
      for (const p of candidates) {
        const label = document.createElement("label");
        label.className = "modal__check";
        label.innerHTML = `<input type="checkbox" name="add-peer" value="${p.peerId}" /> <span></span>`;
        label.querySelector("span").textContent = p.displayName || p.peerId;
        list.append(label);
      }
      body.append(list);
    },
    () => {
      const ids = [
        ...els.modalBody.querySelectorAll('input[name="add-peer"]:checked'),
      ].map((el) => /** @type {HTMLInputElement} */ (el).value);
      if (!ids.length) return;
      closeModal();
      if (mode === "online" && session) {
        session.dispatchHostAction({
          type: "add-group-members",
          chatId: activeChatId,
          memberPeerIds: ids,
        });
      } else if (mode === "fixture" && fixtureStore) {
        const r = applyHost(
          fixtureStore.hostState,
          {
            type: "add-group-members",
            chatId: activeChatId,
            memberPeerIds: ids,
          },
          { actorPeerId: fixtureStore.selfPeerId },
        );
        if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
        paint();
      }
    },
    "Add",
  );
}

function closeModal() {
  els.modal.hidden = true;
  modalConfirm = null;
  els.modalBody.innerHTML = "";
  if (els.modalOk) {
    els.modalOk.hidden = false;
    els.modalOk.disabled = false;
  }
}

function openModal(title, bodyBuilder, onOk, okLabel = "OK") {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = "";
  bodyBuilder(els.modalBody);
  modalConfirm = onOk;
  if (els.modalOk) {
    els.modalOk.textContent = okLabel;
    els.modalOk.hidden = false;
    els.modalOk.disabled = false;
  }
  els.modal.hidden = false;
}

/**
 * Build a clickable sticker grid; clicking a sticker sends it and closes.
 * @param {{ name: string, stickers: Array<{ id: string, emoji?: string, thumbnail_url?: string }> }} pack
 */
function buildStickerModalGrid(pack) {
  const grid = document.createElement("div");
  grid.className = "sticker-modal-grid";
  for (const s of pack.stickers) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sticker-modal-cell";
    btn.title = s.emoji || s.id;
    const img = document.createElement("img");
    img.src = s.thumbnail_url || stickerFileUrl(pack.name, s.id);
    img.alt = s.emoji || "sticker";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(document.createTextNode(s.emoji || "?"));
    });
    btn.append(img);
    btn.addEventListener("click", () => {
      sendSticker({ pack: pack.name, stickerId: s.id, emoji: s.emoji });
      closeModal();
    });
    grid.append(btn);
  }
  return grid;
}

/**
 * Sticker tapped in a message -> show a pack-preview modal.
 * Installed packs offer Share; uninstalled packs offer Add.
 * @param {{ pack: string, stickerId: string, emoji?: string }} ref
 */
function openStickerPackModal(ref) {
  const installed = getPack(ref.pack);
  if (installed) {
    openModal(
      installed.title || installed.name,
      (body) => {
        body.append(buildStickerModalGrid(installed));
      },
      () => {
        const link = `https://t.me/addstickers/${installed.name}`;
        navigator.clipboard?.writeText(link).then(
          () => showBanner("Sticker pack link copied", true),
          () => showBanner(link, true),
        );
        closeModal();
      },
      "Share stickers",
    );
    return;
  }

  openModal(
    ref.pack,
    (body) => {
      const note = document.createElement("p");
      note.className = "modal__note";
      note.textContent = "Loading pack…";
      body.append(note);
    },
    () => {},
    "Add stickers",
  );
  if (els.modalOk) els.modalOk.disabled = true;

  fetchPack(ref.pack)
    .then((pack) => {
      els.modalTitle.textContent = pack.title || pack.name;
      els.modalBody.innerHTML = "";
      els.modalBody.append(buildStickerModalGrid(pack));
      if (els.modalOk) els.modalOk.disabled = false;
      modalConfirm = async () => {
        if (els.modalOk) els.modalOk.disabled = true;
        const result = await addPacks([pack.name]);
        if (result.ok.length) {
          showBanner(`Added ${pack.title || pack.name}`, true);
          picker.focusPack(result.ok);
        } else {
          showBanner("Could not add pack", false);
        }
        closeModal();
      };
    })
    .catch(() => {
      els.modalBody.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "sticker-modal-grid";
      const cell = document.createElement("div");
      cell.className = "sticker-modal-cell";
      const img = document.createElement("img");
      img.src = stickerFileUrl(ref.pack, ref.stickerId);
      img.alt = ref.emoji || "sticker";
      img.addEventListener("error", () => {
        img.replaceWith(document.createTextNode(ref.emoji || "?"));
      });
      cell.append(img);
      wrap.append(cell);
      els.modalBody.append(wrap);
      const note = document.createElement("p");
      note.className = "modal__note";
      note.textContent = "Couldn't load this pack (offline?).";
      els.modalBody.append(note);
      if (els.modalOk) els.modalOk.hidden = true;
    });
}

function openNewDmModal() {
  const store = getStore();
  if (!store || mode !== "online" || !session) return;
  const others = store.hostState.roster.filter(
    (r) => r.peerId !== store.selfPeerId,
  );
  if (!others.length) {
    showBanner("No other peers in the session yet", false);
    return;
  }
  openModal(
    "New DM",
    (body) => {
      const list = document.createElement("div");
      list.className = "modal__list";
      for (const p of others) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "dm-peer";
        input.value = p.peerId;
        label.append(input, document.createTextNode(` ${p.displayName}`));
        list.append(label);
      }
      body.append(list);
    },
    () => {
      const picked = els.modalBody.querySelector(
        'input[name="dm-peer"]:checked',
      );
      if (!picked) return;
      const dmId = session.openDm(picked.value);
      if (dmId) activeChatId = dmId;
      closeModal();
      paint();
    },
    "Create",
  );
}

function openNewGroupModal() {
  const store = getStore();
  if (!store || mode !== "online" || !session) return;
  const others = store.hostState.roster.filter(
    (r) => r.peerId !== store.selfPeerId,
  );
  openModal(
    "New group",
    (body) => {
      const titleField = document.createElement("label");
      titleField.className = "field";
      titleField.innerHTML = `<span>Title</span><input id="group-title" maxlength="48" placeholder="Group name" />`;
      body.append(titleField);
      const hint = document.createElement("p");
      hint.style.cssText =
        "font-size:13px;color:var(--text-secondary);margin:0 0 8px";
      hint.textContent = "Select members (you are included automatically):";
      body.append(hint);
      const list = document.createElement("div");
      list.className = "modal__list";
      for (const p of others) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = "group-peer";
        input.value = p.peerId;
        input.checked = true;
        label.append(input, document.createTextNode(` ${p.displayName}`));
        list.append(label);
      }
      body.append(list);
    },
    () => {
      const title =
        els.modalBody.querySelector("#group-title")?.value?.trim() || "Group";
      const memberPeerIds = [
        ...els.modalBody.querySelectorAll('input[name="group-peer"]:checked'),
      ].map((el) => el.value);
      const knownBefore = new Set(
        Object.keys(session.hostState?.groups || {}),
      );
      const createdId = session.dispatchHostAction({
        type: "create-group",
        title,
        memberPeerIds,
      });
      closeModal();
      if (typeof createdId === "string") {
        // Host mints the id synchronously — open it right away.
        activeChatId = createdId;
        unread[createdId] = 0;
        clearReply();
        clearEdit();
      } else {
        // Guest creator: the group id only exists after the host's create event
        // round-trips; select it once it lands (see paint()).
        pendingGroupSelect = { known: knownBefore, at: Date.now() };
      }
      paint();
    },
    "Create",
  );
}

/** @type {Set<string>} */
const unlockedFixtureMedia = new Set();

function resolveMediaMime(mediaId) {
  if (mode === "online" && session) {
    return session.getMediaEntry(mediaId)?.mime || null;
  }
  if (mode === "fixture" && fixtureStore?.media) {
    return fixtureStore.media.get(mediaId)?.mime || null;
  }
  return null;
}

function resolvePlayableMediaUrl(mediaId, gate = {}) {
  if (mode === "online" && session) {
    return session.getPlayableMediaUrl(mediaId, gate);
  }
  if (mode === "fixture" && fixtureStore?.media) {
    const entry = fixtureStore.media.get(mediaId);
    if (!entry?.blob) return null;
    const size = Number(gate.size) || entry.size || 0;
    const mime = String(gate.mime || entry.mime || "").toLowerCase();
    const large =
      isDeferredTransferMime(mime) && size > VIDEO_AUTO_DOWNLOAD_BYTES;
    if (large && !gate.outgoing && !unlockedFixtureMedia.has(mediaId)) {
      return null;
    }
    if (!entry.objectUrl) entry.objectUrl = URL.createObjectURL(entry.blob);
    return entry.objectUrl;
  }
  return null;
}

function resolveMediaUrl(mediaId) {
  if (mode === "online" && session) {
    return session.getMediaUrl(mediaId);
  }
  if (mode === "fixture" && fixtureStore?.media) {
    const entry = fixtureStore.media.get(mediaId);
    if (!entry?.blob) return null;
    if (!entry.objectUrl) entry.objectUrl = URL.createObjectURL(entry.blob);
    return entry.objectUrl;
  }
  return null;
}

/** @type {{ items: { mediaId: string, messageId: string }[], index: number }} */
let gallery = { items: [], index: 0 };

function getActiveThread() {
  const store = getStore();
  if (!store || !activeChatId) return null;
  return getChatThread(store.hostState, store.dmState, activeChatId);
}

/** Ordered list of viewable images (single photos + album frames) in the thread. */
function buildGalleryItems() {
  const thread = getActiveThread();
  /** @type {{ mediaId: string, messageId: string }[]} */
  const items = [];
  if (!thread?.messages) return items;
  for (const msg of thread.messages) {
    if (msg.kind !== "media" && msg.kind !== "album") continue;
    for (const mediaId of msg.mediaIds || []) {
      if (resolveMediaUrl(mediaId)) items.push({ mediaId, messageId: msg.id });
    }
  }
  return items;
}

function openLightboxGallery(mediaId, messageId) {
  if (!els.lightbox || !els.lightboxImg) return;
  gallery.items = buildGalleryItems();
  let idx = gallery.items.findIndex(
    (it) => it.mediaId === mediaId && it.messageId === messageId,
  );
  if (idx < 0) idx = gallery.items.findIndex((it) => it.mediaId === mediaId);
  if (idx < 0) {
    // Not in the computed list (e.g. url just became available); show it alone.
    const url = resolveMediaUrl(mediaId);
    if (!url) return;
    gallery.items = [{ mediaId, messageId }];
    idx = 0;
  }
  gallery.index = idx;
  els.lightbox.hidden = false;
  showLightboxAt(idx);
}

function showLightboxAt(i) {
  const items = gallery.items;
  if (!items.length) return;
  gallery.index = ((i % items.length) + items.length) % items.length;
  const url = resolveMediaUrl(items[gallery.index].mediaId);
  if (url) els.lightboxImg.src = url;
  const multiple = items.length > 1;
  if (els.lightboxCounter) {
    els.lightboxCounter.hidden = !multiple;
    els.lightboxCounter.textContent = multiple
      ? `${gallery.index + 1} / ${items.length}`
      : "";
  }
  if (els.lightboxPrev) els.lightboxPrev.hidden = !multiple;
  if (els.lightboxNext) els.lightboxNext.hidden = !multiple;
}

function lightboxNext() {
  showLightboxAt(gallery.index + 1);
}

function lightboxPrev() {
  showLightboxAt(gallery.index - 1);
}

function isLightboxOpen() {
  return els.lightbox && !els.lightbox.hidden;
}

function closeLightbox() {
  if (!els.lightbox || !els.lightboxImg) return;
  els.lightbox.hidden = true;
  els.lightboxImg.removeAttribute("src");
  gallery = { items: [], index: 0 };
}

function setUploadStatus(text) {
  if (!els.uploadStatus) return;
  if (!text) {
    els.uploadStatus.hidden = true;
    els.uploadStatus.textContent = "";
    return;
  }
  els.uploadStatus.hidden = false;
  els.uploadStatus.textContent = text;
}

function clearPendingFiles() {
  for (const p of pendingFiles) URL.revokeObjectURL(p.url);
  pendingFiles = [];
  renderPendingStrip();
}

function renderPendingStrip() {
  if (!els.attachPending) return;
  els.attachPending.innerHTML = "";
  if (!pendingFiles.length) {
    els.attachPending.hidden = true;
    return;
  }
  els.attachPending.hidden = false;
  for (const p of pendingFiles) {
    const wrap = document.createElement("div");
    wrap.className = "attach-pending__thumb";
    if (p.file.type.startsWith("video/")) {
      wrap.classList.add("attach-pending__thumb--video");
      wrap.textContent = "Video";
    } else if (p.file.type.startsWith("audio/")) {
      wrap.classList.add("attach-pending__thumb--audio");
      wrap.textContent = "Audio";
    } else if (p.file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = p.url;
      img.alt = "";
      wrap.append(img);
    } else {
      wrap.classList.add("attach-pending__thumb--file");
      wrap.textContent = middleTruncate(p.file.name || "File", 14);
      wrap.title = p.file.name || "File";
    }
    els.attachPending.append(wrap);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn btn--small attach-pending__clear";
  clear.textContent = "Clear";
  clear.addEventListener("click", clearPendingFiles);
  els.attachPending.append(clear);
}

/**
 * @param {FileList | File[]} list
 */
function addPendingFiles(list) {
  const incoming = [...list];
  if (!incoming.length) return;

  const isImage = (f) => f.type.startsWith("image/");
  const isVideo = (f) => f.type.startsWith("video/");
  const isAudio = (f) => f.type.startsWith("audio/");
  const isDoc = (f) => !isImage(f) && !isVideo(f) && !isAudio(f);

  const hasVideo = incoming.some(isVideo);
  const hasAudio = incoming.some(isAudio);
  const hasImage = incoming.some(isImage);
  const hasFile = incoming.some(isDoc);
  const kinds = [hasImage, hasVideo, hasAudio, hasFile].filter(Boolean).length;
  if (kinds > 1) {
    showBanner("Cannot mix photos, video, audio, and files", false);
    return;
  }

  const pendingHasVideo = pendingFiles.some((p) => isVideo(p.file));
  const pendingHasAudio = pendingFiles.some((p) => isAudio(p.file));
  const pendingHasFile = pendingFiles.some((p) => isDoc(p.file));
  const pendingHasImage = pendingFiles.some((p) => isImage(p.file));

  if (hasVideo) {
    if (incoming.filter(isVideo).length > 1) {
      showBanner("Send one video at a time", false);
      return;
    }
    clearPendingFiles();
    const file = incoming.find(isVideo);
    if (file) pendingFiles.push({ file, url: URL.createObjectURL(file) });
    renderPendingStrip();
    return;
  }

  if (hasAudio) {
    if (incoming.filter(isAudio).length > 1) {
      showBanner("Send one audio at a time", false);
      return;
    }
    clearPendingFiles();
    const file = incoming.find(isAudio);
    if (file) pendingFiles.push({ file, url: URL.createObjectURL(file) });
    renderPendingStrip();
    return;
  }

  if (hasFile) {
    if (incoming.filter(isDoc).length > 1) {
      showBanner("Send one file at a time", false);
      return;
    }
    clearPendingFiles();
    const file = incoming.find(isDoc);
    if (file) pendingFiles.push({ file, url: URL.createObjectURL(file) });
    renderPendingStrip();
    return;
  }

  if (pendingHasVideo || pendingHasAudio || pendingHasFile) clearPendingFiles();
  if (pendingHasImage === false && pendingFiles.length) clearPendingFiles();

  const room = MAX_ALBUM_ITEMS - pendingFiles.length;
  if (room <= 0) {
    showBanner(`Max ${MAX_ALBUM_ITEMS} photos`, false);
    return;
  }
  const images = incoming.filter(isImage);
  for (const file of images.slice(0, room)) {
    pendingFiles.push({ file, url: URL.createObjectURL(file) });
  }
  if (images.length > room) {
    showBanner(`Max ${MAX_ALBUM_ITEMS} photos — extra ignored`, false);
  }
  renderPendingStrip();
}

async function sendPendingMedia() {
  if (!activeChatId || !pendingFiles.length || sendingMedia) return;
  const store = getStore();
  if (!store) return;
  const thread = getChatThread(
    store.hostState,
    store.dmState,
    activeChatId,
  );
  if (!thread) return;

  const captionRaw = els.composeInput.value;
  const parsed = captionRaw.trim()
    ? parseMarkdownLite(captionRaw)
    : { text: "", entities: [] };
  const files = pendingFiles.map((p) => p.file);
  const replyTo = replyToId || undefined;

  sendingMedia = true;
  paint();
  try {
    if (mode === "fixture" && fixtureStore) {
      setUploadStatus("Preparing media…");
      if (!fixtureStore.media) fixtureStore.media = new Map();
      const isVideo = files.length === 1 && files[0].type.startsWith("video/");
      const isAudio = files.length === 1 && files[0].type.startsWith("audio/");
      const isFile =
        files.length === 1 &&
        !files[0].type.startsWith("image/") &&
        !files[0].type.startsWith("video/") &&
        !files[0].type.startsWith("audio/");
      /** @type {string[]} */
      const mediaIds = [];
      let i = 0;
      for (const file of files) {
        i += 1;
        if (isVideo) {
          setUploadStatus(`Preparing video… ${formatBytes(file.size)}`);
          const prepared = await prepareVideo(file);
          const id = mintMediaId();
          let thumbDataUrl;
          if (isDeferredPlayableSize(prepared.size)) {
            setUploadStatus("Making thumbnail…");
            thumbDataUrl = await captureVideoThumbDataUrl(prepared.blob);
          }
          fixtureStore.media.set(id, {
            blob: prepared.blob,
            mime: prepared.mime,
            size: prepared.size,
            width: prepared.width,
            height: prepared.height,
            duration: prepared.duration,
            senderPeerId: fixtureStore.selfPeerId,
            thumbDataUrl,
          });
          unlockedFixtureMedia.add(id);
          mediaIds.push(id);
        } else if (isAudio) {
          setUploadStatus(`Preparing audio… ${formatBytes(file.size)}`);
          const prepared = await prepareAudio(file);
          const id = mintMediaId();
          fixtureStore.media.set(id, {
            blob: prepared.blob,
            mime: prepared.mime,
            size: prepared.size,
            duration: prepared.duration,
            senderPeerId: fixtureStore.selfPeerId,
          });
          unlockedFixtureMedia.add(id);
          mediaIds.push(id);
        } else if (isFile) {
          setUploadStatus(`Preparing file… ${formatBytes(file.size)}`);
          const prepared = await prepareFile(file);
          const id = mintMediaId();
          fixtureStore.media.set(id, {
            blob: prepared.blob,
            mime: prepared.mime,
            size: prepared.size,
            fileName: prepared.fileName,
            senderPeerId: fixtureStore.selfPeerId,
          });
          unlockedFixtureMedia.add(id);
          mediaIds.push(id);
        } else {
          setUploadStatus(`Compressing ${i}/${files.length}…`);
          const compressed = await compressImage(file);
          const id = mintMediaId();
          fixtureStore.media.set(id, {
            blob: compressed.blob,
            mime: compressed.mime,
            size: compressed.size,
            width: compressed.width,
            height: compressed.height,
            senderPeerId: fixtureStore.selfPeerId,
          });
          mediaIds.push(id);
        }
      }
      const mediaKind = isVideo
        ? "video"
        : isAudio
          ? "audio"
          : isFile
            ? "file"
            : undefined;
      const mediaInfoOut = mediaIds.map((id) => {
        const e = fixtureStore.media.get(id);
        return {
          size: e?.size || 0,
          mime: e?.mime,
          duration: e?.duration,
          width: e?.width,
          height: e?.height,
          thumbDataUrl: e?.thumbDataUrl,
          fileName: e?.fileName,
        };
      });
      if (thread.kind === "group") {
        const r = applyHost(
          fixtureStore.hostState,
          {
            type: "send-media",
            chatId: activeChatId,
            mediaIds,
            mediaInfo: mediaInfoOut,
            mediaKind,
            text: parsed.text || undefined,
            entities: parsed.entities.length ? parsed.entities : undefined,
            replyTo,
          },
          { actorPeerId: fixtureStore.selfPeerId },
        );
        if (!r.ok) throw new Error(r.error || "Send failed");
        fixtureStore = { ...fixtureStore, hostState: r.state, media: fixtureStore.media };
      } else {
        const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
          type: "dm-send-media",
          dmId: activeChatId,
          mediaIds,
          mediaInfo: mediaInfoOut,
          mediaKind,
          text: parsed.text || undefined,
          entities: parsed.entities.length ? parsed.entities : undefined,
          replyTo,
        });
        if (!r.ok) throw new Error(r.error || "Send failed");
        fixtureStore = { ...fixtureStore, dmState: r.state, media: fixtureStore.media };
      }
    } else if (session && !session.sessionEnded) {
      const label =
        files.length === 1 && files[0].type.startsWith("video/")
          ? `Preparing video… ${formatBytes(files[0].size)}`
          : files.length === 1 && files[0].type.startsWith("audio/")
            ? `Preparing audio… ${formatBytes(files[0].size)}`
            : files.length === 1 &&
                !files[0].type.startsWith("image/") &&
                !files[0].type.startsWith("video/") &&
                !files[0].type.startsWith("audio/")
              ? `Preparing file… ${formatBytes(files[0].size)}`
              : "Preparing media…";
      setUploadStatus(label);
      if (thread.kind === "group") {
        const prepared = await session.prepareGroupMedia(files, {
          chatId: activeChatId,
          onProgress: setUploadStatus,
        });
        setUploadStatus("Sending…");
        session.sendGroupMedia(activeChatId, {
          mediaIds: prepared.mediaIds,
          mediaInfo: prepared.mediaInfo,
          mediaKind: prepared.mediaKind,
          text: parsed.text || undefined,
          entities: parsed.entities.length ? parsed.entities : undefined,
          replyTo,
        });
      } else {
        await session.sendDmMedia(activeChatId, files, {
          text: parsed.text || undefined,
          entities: parsed.entities.length ? parsed.entities : undefined,
          replyTo,
          onProgress: setUploadStatus,
        });
      }
    } else {
      throw new Error("Not connected");
    }
    els.composeInput.value = "";
    clearPendingFiles();
    clearReply();
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("[ephchat] media send failed", e);
    showBanner(msg, false);
  } finally {
    sendingMedia = false;
    setUploadStatus("");
    paint();
  }
}

async function sendOrSave() {
  if (pendingFiles.length) {
    await sendPendingMedia();
    return;
  }

  const raw = els.composeInput.value;
  if (!raw.trim() || !activeChatId) return;
  const store = getStore();
  if (!store) return;
  const thread = getChatThread(
    store.hostState,
    store.dmState,
    activeChatId,
  );
  if (!thread) return;

  const parsed = parseMarkdownLite(raw);

  if (editing) {
    if (mode === "online" && session) {
      if (thread.kind === "group") {
        session.editGroupMessage(
          editing.chatId,
          editing.messageId,
          parsed.text,
          parsed.entities,
        );
      } else {
        session.editDmMessage(
          editing.chatId,
          editing.messageId,
          parsed.text,
          parsed.entities,
        );
      }
    } else if (mode === "fixture" && fixtureStore) {
      if (thread.kind === "group") {
        const r = applyHost(
          fixtureStore.hostState,
          {
            type: "edit-message",
            chatId: editing.chatId,
            messageId: editing.messageId,
            text: parsed.text,
            entities: parsed.entities,
          },
          { actorPeerId: fixtureStore.selfPeerId },
        );
        if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
      } else {
        const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
          type: "dm-edit",
          dmId: editing.chatId,
          messageId: editing.messageId,
          text: parsed.text,
          entities: parsed.entities,
        });
        if (r.ok) fixtureStore = { ...fixtureStore, dmState: r.state };
      }
      paint();
    }
    els.composeInput.value = "";
    clearEdit();
    return;
  }

  const opts = {
    replyTo: replyToId || undefined,
    entities: parsed.entities.length ? parsed.entities : undefined,
  };

  if (mode === "fixture" && fixtureStore) {
    if (thread.kind === "group") {
      const r = applyHost(
        fixtureStore.hostState,
        {
          type: "send-text",
          chatId: activeChatId,
          text: parsed.text,
          ...opts,
        },
        { actorPeerId: fixtureStore.selfPeerId },
      );
      if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    } else {
      const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
        type: "dm-send-text",
        dmId: activeChatId,
        text: parsed.text,
        ...opts,
      });
      if (r.ok) fixtureStore = { ...fixtureStore, dmState: r.state };
    }
    paint();
  } else if (session && !session.sessionEnded) {
    if (thread.kind === "group") {
      session.sendGroupText(activeChatId, parsed.text, opts);
    } else {
      session.sendDmText(activeChatId, parsed.text, opts);
    }
  }

  els.composeInput.value = "";
  clearReply();
}

els.composeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  await sendOrSave();
  els.composeInput.focus();
});

els.composeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composeForm.requestSubmit();
  }
});

els.attachBtn?.addEventListener("click", () => els.attachInput?.click());
els.attachInput?.addEventListener("change", () => {
  if (els.attachInput?.files?.length) {
    addPendingFiles(els.attachInput.files);
    els.attachInput.value = "";
  }
});

els.lightbox?.addEventListener("click", (e) => {
  // Close only when the dark backdrop itself is clicked (not the image/buttons).
  if (e.target === els.lightbox) closeLightbox();
});
els.lightboxClose?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeLightbox();
});
els.lightboxPrev?.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxPrev();
});
els.lightboxNext?.addEventListener("click", (e) => {
  e.stopPropagation();
  lightboxNext();
});
els.lightboxImg?.addEventListener("click", (e) => e.stopPropagation());

let lightboxTouchX = null;
els.lightbox?.addEventListener(
  "pointerdown",
  (e) => {
    lightboxTouchX = e.clientX;
  },
  { passive: true },
);
els.lightbox?.addEventListener("pointerup", (e) => {
  if (lightboxTouchX === null) return;
  const dx = e.clientX - lightboxTouchX;
  lightboxTouchX = null;
  if (Math.abs(dx) > 50 && gallery.items.length > 1) {
    if (dx < 0) lightboxNext();
    else lightboxPrev();
  }
});

window.addEventListener("keydown", (e) => {
  if (isLightboxOpen()) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      lightboxNext();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      lightboxPrev();
      return;
    }
  }
  if (e.key === "Escape") {
    closeLightbox();
    closeSidebarMenu();
  }
});

applyUiPrefs();
initSidebarResize();

els.messages?.addEventListener("scroll", updateJumpFab);
els.jumpFab?.addEventListener("click", () => {
  els.messages.scrollTop = els.messages.scrollHeight;
  updateJumpFab();
});
els.replyBarClear?.addEventListener("click", clearReply);
els.editBarClear?.addEventListener("click", () => {
  clearEdit();
  els.composeInput.value = "";
});

els.inviteCopy?.addEventListener("click", async () => {
  const url = els.inviteUrl?.value;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    showBanner("Invite copied", true);
  } catch {
    els.inviteUrl.select();
    showBanner("Select and copy the invite link", false);
  }
});

els.menuToggle?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSidebarMenu();
});
els.collapseToggle?.addEventListener("click", toggleRail);
els.btnRename?.addEventListener("click", () => {
  closeSidebarMenu();
  renameSessionPrompt();
});
els.chatSearch?.addEventListener("input", () => {
  chatFilter = els.chatSearch.value || "";
  paint();
});
els.sidebarMenu?.addEventListener("click", (e) => {
  if (e.target.closest(".menu-item")) closeSidebarMenu();
});
document.addEventListener("click", (e) => {
  if (
    els.sidebarMenu &&
    !els.sidebarMenu.hidden &&
    !els.sidebarMenu.contains(e.target) &&
    !els.menuToggle?.contains(e.target)
  ) {
    closeSidebarMenu();
  }
});
els.btnNewDm?.addEventListener("click", openNewDmModal);
els.btnNewGroup?.addEventListener("click", openNewGroupModal);
els.btnAdmin?.addEventListener("click", openAdminModal);
els.btnEndSession?.addEventListener("click", () => {
  if (!confirm("End the session for everyone?")) return;
  if (mode === "online" && session) session.endSession();
  else if (mode === "fixture" && fixtureStore) {
    const r = applyHost(
      fixtureStore.hostState,
      { type: "admin-end-session" },
      { actorPeerId: fixtureStore.selfPeerId },
    );
    if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    paint();
  }
});
els.sessionLabel?.addEventListener("click", renameSessionPrompt);
els.pickerToggle?.addEventListener("click", togglePicker);
els.modalCancel?.addEventListener("click", closeModal);
els.modalOk?.addEventListener("click", () => {
  modalConfirm?.();
});
els.modal?.addEventListener("click", (e) => {
  if (e.target === els.modal) closeModal();
});

window.addEventListener("pagehide", () => {
  persistResume();
  // Soft leave — do not broadcast session-ended so a refresh can resume.
  session?.leave({ endSession: false });
});

if (isFixtureMode()) {
  startFixture();
} else {
  const resume = loadResume();

  if (joinId) {
    // Join links only need a display name — remove title field entirely.
    els.landingTitleField?.remove();
    els.landingRoomField?.remove();
    if (els.landingJoinHint) {
      els.landingJoinHint.hidden = false;
      els.landingJoinHint.textContent = `Joining session ${joinId} · enter the password if the host set one`;
    }
    const joinPwLabel = els.landingPasswordField?.querySelector("span");
    if (joinPwLabel) joinPwLabel.textContent = "Password (if required)";
    if (els.landingSubmit) els.landingSubmit.textContent = "Join session";
  } else {
    const updateEntryMode = () => {
      const roomId = String(
        permanentRoomId || els.landingRoom?.value || "",
      ).trim();
      if (els.landingTitleField) els.landingTitleField.hidden = Boolean(roomId);
      if (els.landingSubmit) {
        els.landingSubmit.textContent = roomId
          ? "Enter room"
          : "Create session";
      }
      if (els.landingJoinHint) {
        els.landingJoinHint.hidden = !roomId;
        els.landingJoinHint.textContent = roomId
          ? `Reusable room ${roomId} · a password is required to connect if one is set`
          : "";
      }
      const pwLabel = els.landingPasswordField?.querySelector("span");
      if (pwLabel) {
        pwLabel.textContent = roomId
          ? "Password (if required)"
          : "Set a password (optional)";
      }
    };
    if (permanentRoomId && els.landingRoom) {
      els.landingRoom.value = permanentRoomId;
    }
    els.landingRoom?.addEventListener("input", updateEntryMode);
    updateEntryMode();
  }

  // Auto-resume after refresh (same tab). Prefer ?join= when present.
  if (resume && !isFixtureMode()) {
    if (els.landingName) els.landingName.value = resume.displayName || "";
    if (
      !joinId &&
      (permanentRoomId || resume.roomMode === "permanent") &&
      (!permanentRoomId || resume.permanentRoomId === permanentRoomId)
    ) {
      startPermanentRoom(
        resume.displayName,
        permanentRoomId || resume.permanentRoomId,
        resume,
      );
    } else if (resume.role === "host" && !joinId && !permanentRoomId) {
      startOnlineHost(resume.displayName, resume.title || "", resume);
    } else if (
      resume.role === "guest" &&
      (!joinId || resume.sessionId === joinId)
    ) {
      const sid = joinId || resume.sessionId;
      startOnlineGuest(resume.displayName, sid, resume);
    }
  }

  els.landingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const displayName = els.landingName.value.trim();
    if (!displayName) return;
    const password = els.landingPassword?.value || "";
    clearResume();
    if (joinId) {
      startOnlineGuest(displayName, joinId, undefined, password);
    } else if (els.landingRoom?.value?.trim()) {
      startPermanentRoom(
        displayName,
        els.landingRoom.value.trim(),
        undefined,
        password,
      );
    } else {
      startOnlineHost(
        displayName,
        els.landingTitle?.value?.trim() || "",
        undefined,
        password,
      );
    }
  });
}
