import {
  applyDm,
  applyHost,
  assertHostExcludesDms,
  getChatThread,
  listChatsForUi,
} from "../engine.js";
import { buildFixture } from "../fixture.js";
import { selfCheckEnvelope } from "../protocol.js";
import { renderChatList, renderThread } from "./render.js";

const els = {
  chatList: document.querySelector("#chat-list"),
  chatHeader: document.querySelector("#chat-header"),
  messages: document.querySelector("#messages"),
  composeForm: document.querySelector("#compose-form"),
  composeInput: document.querySelector("#compose-input"),
  composeSend: document.querySelector("#compose-send"),
  bootBanner: document.querySelector("#boot-banner"),
  sessionLabel: document.querySelector("#session-label"),
};

/** @type {{ selfPeerId: string, hostState: import("../engine.js").HostState, dmState: import("../engine.js").DmState }} */
let store = buildFixture();
/** @type {string | null} */
let activeChatId = null;

function runBootAsserts() {
  const checks = [];

  if (!selfCheckEnvelope()) {
    checks.push("envelope self-check failed");
  } else {
    checks.push("envelope mode=none ok");
  }

  const privacy = assertHostExcludesDms(store.hostState, store.dmState);
  if (!privacy.ok) {
    checks.push(`DM privacy FAIL: ${privacy.error}`);
  } else {
    checks.push("host snapshot excludes DMs");
  }

  const ok = privacy.ok && selfCheckEnvelope();
  if (els.bootBanner) {
    els.bootBanner.hidden = false;
    els.bootBanner.className =
      "boot-banner " + (ok ? "boot-banner--ok" : "boot-banner--err");
    els.bootBanner.textContent = checks.join(" · ");
    if (ok) {
      setTimeout(() => {
        els.bootBanner.hidden = true;
      }, 4500);
    }
  }

  if (!ok) {
    console.error("[phase0] boot asserts failed", checks);
  } else {
    console.info("[phase0]", checks.join(" · "));
  }
  return ok;
}

function paint() {
  const chats = listChatsForUi(
    store.hostState,
    store.dmState,
    store.selfPeerId,
  );
  if (!activeChatId && chats.length) {
    activeChatId = chats[0].id;
  }

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
  );

  const canSend = Boolean(thread);
  els.composeInput.disabled = !canSend;
  els.composeSend.disabled = !canSend;

  if (els.sessionLabel) {
    els.sessionLabel.textContent = store.hostState.session.title || "Session";
  }
}

function sendText(text) {
  const trimmed = text.trim();
  if (!trimmed || !activeChatId) return;

  const thread = getChatThread(
    store.hostState,
    store.dmState,
    activeChatId,
  );
  if (!thread) return;

  if (thread.kind === "group") {
    const r = applyHost(
      store.hostState,
      { type: "send-text", chatId: activeChatId, text: trimmed },
      { actorPeerId: store.selfPeerId },
    );
    if (!r.ok) {
      console.warn(r.error);
      return;
    }
    store = { ...store, hostState: r.state };
  } else {
    const r = applyDm(store.dmState, store.selfPeerId, {
      type: "dm-send-text",
      dmId: activeChatId,
      text: trimmed,
    });
    if (!r.ok) {
      console.warn(r.error);
      return;
    }
    store = { ...store, dmState: r.state };
    // Re-check privacy after local DM send
    const privacy = assertHostExcludesDms(store.hostState, store.dmState);
    if (!privacy.ok) console.error(privacy.error);
  }

  paint();
}

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

runBootAsserts();
paint();
