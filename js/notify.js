/**
 * Desktop (OS tray) notifications for new messages.
 * No app audio — uses Notification silent when supported.
 */

const PROMPT_KEY = "ephchat.notifyPrompt";

export function notificationsSupported() {
  return typeof Notification !== "undefined";
}

/** @returns {"default" | "granted" | "denied"} */
export function getPermission() {
  if (!notificationsSupported()) return "denied";
  return Notification.permission;
}

/** True when we should show the one-shot Enable banner. */
export function shouldPromptForNotifications() {
  if (!notificationsSupported()) return false;
  if (Notification.permission !== "default") return false;
  try {
    return localStorage.getItem(PROMPT_KEY) !== "1";
  } catch {
    return false;
  }
}

export function markNotifyPromptSeen() {
  try {
    localStorage.setItem(PROMPT_KEY, "1");
  } catch {
    /* private mode */
  }
}

/** @returns {Promise<"default" | "granted" | "denied">} */
export async function requestPermission() {
  markNotifyPromptSeen();
  if (!notificationsSupported()) return "denied";
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return "denied";
  }
}

/**
 * Short body line for a message (mirrors sidebar preview kinds).
 * @param {{ kind?: string, text?: string, mediaInfo?: Array<{ fileName?: string }> } | null | undefined} msg
 */
export function notificationBody(msg) {
  if (!msg) return "New message";
  if (msg.kind === "system") return msg.text || "System";
  if (msg.kind === "sticker") return "Sticker";
  if (msg.kind === "video") return msg.text?.trim() || "Video";
  if (msg.kind === "audio") return msg.text?.trim() || "Audio";
  if (msg.kind === "file") {
    return msg.text?.trim() || msg.mediaInfo?.[0]?.fileName || "File";
  }
  if (msg.kind === "album") return msg.text?.trim() || "Album";
  if (msg.kind === "media") return msg.text?.trim() || "Photo";
  const text = String(msg.text || "").trim();
  if (!text) return "New message";
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/**
 * @param {{
 *   chatId: string,
 *   title?: string,
 *   body?: string,
 *   onClick?: () => void,
 * }} opts
 * @returns {Notification | null}
 */
export function notifyNewMessage(opts) {
  if (!opts?.chatId) return null;
  if (!notificationsSupported() || Notification.permission !== "granted") {
    return null;
  }
  try {
    const n = new Notification(opts.title || "Telegio", {
      body: opts.body || "New message",
      tag: String(opts.chatId),
      silent: true,
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      try {
        opts.onClick?.();
      } catch {
        /* ignore */
      }
      n.close();
    };
    window.setTimeout(() => {
      try {
        n.close();
      } catch {
        /* ignore */
      }
    }, 6000);
    return n;
  } catch {
    return null;
  }
}
