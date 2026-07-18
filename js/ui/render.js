import { isFullyDelivered, renderEntities } from "../entities.js";

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
      qText.textContent = parent?.text || "Original message";
      quote.append(qName, qText);
      bubble.append(quote);
    }

    const text = document.createElement("div");
    text.className = "bubble__text";
    text.append(renderEntities(msg.text || "", msg.entities));
    bubble.append(text);

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
    if (outgoing && msg.kind === "text") {
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
