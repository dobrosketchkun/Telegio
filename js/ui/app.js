import {
  applyDm,
  applyHost,
  assertHostExcludesDms,
  findMessage,
  getChatThread,
  isHostPeer,
  listChatsForUi,
} from "../engine.js";
import { parseMarkdownLite, toMarkdownLite } from "../entities.js";
import { MAX_ALBUM_ITEMS } from "../constants.js";
import { buildFixture } from "../fixture.js";
import { isFixtureMode, readJoinSessionId } from "../invite.js";
import { log } from "../log.js";
import { compressImage, mintMediaId } from "../media.js";
import { selfCheckEnvelope } from "../protocol.js";
import { ChatSession } from "../session.js";
import { ensureFixturePacks } from "../stickers.js";
import { addPacksFromText, createPicker } from "./picker.js";
import { renderChatList, renderThread } from "./render.js";

const els = {
  landing: document.querySelector("#landing"),
  landingForm: document.querySelector("#landing-form"),
  landingName: document.querySelector("#landing-name"),
  landingTitle: document.querySelector("#landing-title"),
  landingTitleField: document.querySelector("#landing-title-field"),
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
/** @type {Record<string, number>} */
const unread = Object.create(null);
/** @type {Map<string, Set<string>>} */
const seenMessageIds = new Map();

const joinId = readJoinSessionId();
log("boot", {
  href: location.href,
  joinId,
  fixture: isFixtureMode(),
  build: "phase4-media",
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

function trackUnread(store) {
  const chats = listChatsForUi(
    store.hostState,
    store.dmState,
    store.selfPeerId,
  );
  for (const chat of chats) {
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
  els.replyBarText.textContent =
    msg.kind === "sticker"
      ? "Sticker"
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

  const ended = mode === "online" ? session?.sessionEnded : false;
  const asHost =
    mode === "online"
      ? session?.role === "host"
      : isHostPeer(store.hostState, store.selfPeerId);

  const chats = listChatsForUi(
    store.hostState,
    store.dmState,
    store.selfPeerId,
  );
  if (activeChatId && !chats.some((c) => c.id === activeChatId)) {
    activeChatId = null;
    clearReply();
    clearEdit();
  }
  if (!activeChatId && chats.length) {
    activeChatId = chats[0].id;
    unread[activeChatId] = 0;
  }

  renderChatList(els.chatList, chats, activeChatId, unread, (id) => {
    activeChatId = id;
    unread[id] = 0;
    clearReply();
    clearEdit();
    paint();
  });

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
      getMediaUrl: (mediaId) => resolveMediaUrl(mediaId),
      onOpenMedia: (url) => openLightbox(url),
    },
  );

  // Pull missing group media while viewing
  if (mode === "online" && session && thread?.kind === "group") {
    for (const msg of thread.messages) {
      if (msg.mediaIds?.length) session.ensureMedia(msg.mediaIds);
    }
  }

  const canSend = Boolean(thread) && !ended && !sendingMedia;
  els.composeInput.disabled = !canSend;
  els.composeSend.disabled = !canSend;
  if (els.attachBtn) els.attachBtn.disabled = !canSend;
  els.btnNewDm.disabled = ended || !store.hostState.roster.length;
  els.btnNewGroup.disabled = ended || store.hostState.roster.length < 2;

  if (els.sessionLabel) {
    els.sessionLabel.textContent = store.hostState.session.title || "Session";
  }
  updateJumpFab();
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
  picker.focusPack([pack.name]);
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

function togglePicker() {
  if (!els.picker || !els.pickerToggle) return;
  const open = els.picker.hidden;
  els.picker.hidden = !open;
  els.pickerToggle.classList.toggle("is-active", open);
  if (open) picker.render();
}

async function startOnlineHost(displayName, title) {
  mode = "online";
  session = new ChatSession({
    onChange: () => paint(),
    onStatus: (s) => {
      if (els.connStatus) els.connStatus.textContent = s;
    },
    onError: (m) => showBanner(m, false),
  });
  enterAppShell({ badge: "Host", status: "Connecting…" });
  try {
    await session.createHost({ displayName, title });
    // Keep status from session.onStatus (e.g. "Online · waiting for guests")
    if (els.inviteBox && els.inviteUrl && session.inviteUrl) {
      els.inviteBox.hidden = false;
      els.inviteUrl.value = session.inviteUrl;
    }
    paint();
  } catch (e) {
    showBanner(e?.message || String(e), false);
    els.connStatus.textContent = "Connection failed";
  }
}

async function startOnlineGuest(displayName, sessionId) {
  mode = "online";
  session = new ChatSession({
    onChange: () => paint(),
    onStatus: (s) => {
      if (els.connStatus) els.connStatus.textContent = s;
    },
    onError: (m) => showBanner(m, false),
  });
  enterAppShell({ badge: "Guest", status: "Connecting…" });
  try {
    await session.joinGuest({ displayName, sessionId });
    paint();
  } catch (e) {
    showBanner(e?.message || String(e), false);
    els.connStatus.textContent = "Connection failed";
  }
}

function closeModal() {
  els.modal.hidden = true;
  modalConfirm = null;
  els.modalBody.innerHTML = "";
}

function openModal(title, bodyBuilder, onOk) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = "";
  bodyBuilder(els.modalBody);
  modalConfirm = onOk;
  els.modal.hidden = false;
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
      session.dispatchHostAction({
        type: "create-group",
        title,
        memberPeerIds,
      });
      closeModal();
      paint();
    },
  );
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

function openLightbox(url) {
  if (!els.lightbox || !els.lightboxImg || !url) return;
  els.lightboxImg.src = url;
  els.lightbox.hidden = false;
}

function closeLightbox() {
  if (!els.lightbox || !els.lightboxImg) return;
  els.lightbox.hidden = true;
  els.lightboxImg.removeAttribute("src");
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
    const img = document.createElement("img");
    img.src = p.url;
    img.alt = "";
    wrap.append(img);
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
  const files = [...list].filter((f) => f.type.startsWith("image/"));
  const room = MAX_ALBUM_ITEMS - pendingFiles.length;
  if (room <= 0) {
    showBanner(`Max ${MAX_ALBUM_ITEMS} photos`, false);
    return;
  }
  for (const file of files.slice(0, room)) {
    pendingFiles.push({ file, url: URL.createObjectURL(file) });
  }
  if (files.length > room) {
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
      setUploadStatus("Preparing photos…");
      if (!fixtureStore.media) fixtureStore.media = new Map();
      /** @type {string[]} */
      const mediaIds = [];
      let i = 0;
      for (const file of files) {
        i += 1;
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
      if (thread.kind === "group") {
        const r = applyHost(
          fixtureStore.hostState,
          {
            type: "send-media",
            chatId: activeChatId,
            mediaIds,
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
          text: parsed.text || undefined,
          entities: parsed.entities.length ? parsed.entities : undefined,
          replyTo,
        });
        if (!r.ok) throw new Error(r.error || "Send failed");
        fixtureStore = { ...fixtureStore, dmState: r.state, media: fixtureStore.media };
      }
    } else if (session && !session.sessionEnded) {
      if (thread.kind === "group") {
        const mediaIds = await session.uploadGroupMedia(files, {
          chatId: activeChatId,
          onProgress: setUploadStatus,
        });
        setUploadStatus("Sending…");
        session.sendGroupMedia(activeChatId, {
          mediaIds,
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
    showBanner(e?.message || String(e), false);
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

els.lightbox?.addEventListener("click", () => closeLightbox());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
});

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

els.btnNewDm?.addEventListener("click", openNewDmModal);
els.btnNewGroup?.addEventListener("click", openNewGroupModal);
els.pickerToggle?.addEventListener("click", togglePicker);
els.modalCancel?.addEventListener("click", closeModal);
els.modalOk?.addEventListener("click", () => {
  modalConfirm?.();
});
els.modal?.addEventListener("click", (e) => {
  if (e.target === els.modal) closeModal();
});

window.addEventListener("beforeunload", () => {
  session?.leave();
});

if (isFixtureMode()) {
  startFixture();
} else {
  if (joinId) {
    // Join links only need a display name — remove title field entirely.
    els.landingTitleField?.remove();
    if (els.landingJoinHint) {
      els.landingJoinHint.hidden = false;
      els.landingJoinHint.textContent = `Joining session ${joinId}`;
    }
    if (els.landingSubmit) els.landingSubmit.textContent = "Join session";
  }

  els.landingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const displayName = els.landingName.value.trim();
    if (!displayName) return;
    if (joinId) {
      startOnlineGuest(displayName, joinId);
    } else {
      startOnlineHost(displayName, els.landingTitle?.value?.trim() || "");
    }
  });
}
