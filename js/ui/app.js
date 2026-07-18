import {
  applyDm,
  applyHost,
  assertHostExcludesDms,
  getChatThread,
  isHostPeer,
  listChatsForUi,
} from "../engine.js";
import { buildFixture } from "../fixture.js";
import { isFixtureMode, readJoinSessionId } from "../invite.js";
import { selfCheckEnvelope } from "../protocol.js";
import { ChatSession } from "../session.js";
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
};

/** @type {"fixture" | "online" | null} */
let mode = null;
/** @type {ChatSession | null} */
let session = null;
/** @type {{ selfPeerId: string, hostState: import("../engine.js").HostState, dmState: import("../engine.js").DmState } | null} */
let fixtureStore = null;
/** @type {string | null} */
let activeChatId = null;
/** @type {null | (() => void)} */
let modalConfirm = null;

const joinId = readJoinSessionId();

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

function paint() {
  const store = getStore();
  if (!store) return;

  const ended =
    mode === "online" ? session?.sessionEnded : false;
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
  }
  if (!activeChatId && chats.length) activeChatId = chats[0].id;

  renderChatList(els.chatList, chats, activeChatId, (id) => {
    activeChatId = id;
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
        if (mode === "online" && session && activeChatId) {
          session.dispatchHostAction({
            type: "delete-message",
            chatId: activeChatId,
            messageId,
          });
        }
      },
    },
  );

  const canSend = Boolean(thread) && !ended;
  els.composeInput.disabled = !canSend;
  els.composeSend.disabled = !canSend;
  els.btnNewDm.disabled = ended || !store.hostState.roster.length;
  els.btnNewGroup.disabled = ended || store.hostState.roster.length < 2;

  if (els.sessionLabel) {
    els.sessionLabel.textContent = store.hostState.session.title || "Session";
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

function startFixture() {
  mode = "fixture";
  fixtureStore = buildFixture();
  const privacy = assertHostExcludesDms(
    fixtureStore.hostState,
    fixtureStore.dmState,
  );
  const envOk = selfCheckEnvelope();
  showBanner(
    [
      envOk ? "envelope mode=none ok" : "envelope FAIL",
      privacy.ok ? "host snapshot excludes DMs" : privacy.error,
    ].join(" · "),
    envOk && privacy.ok,
  );
  enterAppShell({ badge: "Fixture", status: "Offline fixture" });
  paint();
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
    enterAppShell({
      badge: "Host",
      status: "Connected (1)",
      inviteUrl: session.inviteUrl,
    });
    const privacy = assertHostExcludesDms(session.hostState, session.dmState);
    if (!privacy.ok) console.error(privacy.error);
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
      const list = document.createElement("div");
      list.className = "modal__list";
      const hint = document.createElement("p");
      hint.style.cssText = "font-size:13px;color:var(--text-secondary);margin:0 0 8px";
      hint.textContent = "Select members (you are included automatically):";
      body.append(hint);
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

function sendText(text) {
  const trimmed = text.trim();
  if (!trimmed || !activeChatId) return;
  const store = getStore();
  if (!store) return;
  const thread = getChatThread(
    store.hostState,
    store.dmState,
    activeChatId,
  );
  if (!thread) return;

  if (mode === "fixture" && fixtureStore) {
    if (thread.kind === "group") {
      const r = applyHost(
        fixtureStore.hostState,
        { type: "send-text", chatId: activeChatId, text: trimmed },
        { actorPeerId: fixtureStore.selfPeerId },
      );
      if (r.ok) fixtureStore = { ...fixtureStore, hostState: r.state };
    } else {
      const r = applyDm(fixtureStore.dmState, fixtureStore.selfPeerId, {
        type: "dm-send-text",
        dmId: activeChatId,
        text: trimmed,
      });
      if (r.ok) fixtureStore = { ...fixtureStore, dmState: r.state };
    }
    paint();
    return;
  }

  if (!session || session.sessionEnded) return;
  if (thread.kind === "group") {
    session.sendGroupText(activeChatId, trimmed);
  } else {
    session.sendDmText(activeChatId, trimmed);
  }
}

// —— Wire UI ——
els.composeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const value = els.composeInput.value;
  els.composeInput.value = "";
  sendText(value);
  els.composeInput.focus();
});

els.composeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composeForm.requestSubmit();
  }
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

// —— Boot ——
if (isFixtureMode()) {
  startFixture();
} else {
  if (joinId) {
    els.landingTitleField.hidden = true;
    els.landingJoinHint.hidden = false;
    els.landingJoinHint.textContent = `Joining session: ${joinId}`;
    els.landingSubmit.textContent = "Join session";
  }

  els.landingForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const displayName = els.landingName.value.trim();
    if (!displayName) return;
    if (joinId) {
      startOnlineGuest(displayName, joinId);
    } else {
      startOnlineHost(displayName, els.landingTitle.value.trim());
    }
  });
}
