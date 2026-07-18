/**
 * @param {HTMLElement} root
 * @param {Array<{ id: string, kind: string, title: string, preview: string, updatedAt: number }>} chats
 * @param {string | null} activeId
 * @param {(id: string) => void} onSelect
 */
export function renderChatList(root, chats, activeId, onSelect) {
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

    const kind = document.createElement("div");
    kind.className = "chat-list__kind";
    kind.textContent = chat.kind === "dm" ? "DM" : "Group";

    btn.append(av, main, kind);
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
 */
export function renderThread(headerEl, messagesEl, thread, selfPeerId, hostState) {
  if (!thread) {
    headerEl.innerHTML = `
      <div class="chat-header__meta">
        <h1 class="chat-header__title">Select a chat</h1>
        <p class="chat-header__sub">Fixture mode — no network</p>
      </div>
    `;
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
    <div class="avatar avatar--g${hashHue(chat.id)}" style="width:42px;height:42px;font-size:15px"></div>
    <div class="chat-header__meta">
      <h1 class="chat-header__title"></h1>
      <p class="chat-header__sub"></p>
    </div>
  `;
  headerEl.querySelector(".avatar").textContent = initials(title);
  headerEl.querySelector(".chat-header__title").textContent = title;
  headerEl.querySelector(".chat-header__sub").textContent = sub;

  messagesEl.innerHTML = "";
  for (const msg of messages) {
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

    const text = document.createElement("div");
    text.className = "bubble__text";
    text.textContent = msg.text || "";
    bubble.append(text);

    const meta = document.createElement("div");
    meta.className = "bubble__meta";
    meta.textContent = formatTime(msg.createdAt);
    bubble.append(meta);

    row.append(bubble);
    messagesEl.append(row);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
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
