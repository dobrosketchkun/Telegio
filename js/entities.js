/**
 * @typedef {{ type: "bold" | "italic" | "strike" | "code" | "spoiler" | "url", offset: number, length: number, url?: string }} Entity
 */

const MARKERS = [
  { type: "spoiler", open: "||", close: "||" },
  { type: "code", open: "`", close: "`" },
  { type: "bold", open: "*", close: "*" },
  { type: "italic", open: "_", close: "_" },
  { type: "strike", open: "~", close: "~" },
];

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/**
 * Parse markdown-lite into plain text + entities (UTF-16 code-unit offsets).
 * No nesting; first match left-to-right.
 * @param {string} input
 * @returns {{ text: string, entities: Entity[] }}
 */
export function parseMarkdownLite(input) {
  const src = String(input ?? "");
  let out = "";
  /** @type {Entity[]} */
  const entities = [];
  let i = 0;

  while (i < src.length) {
    let matched = null;
    for (const m of MARKERS) {
      if (src.startsWith(m.open, i)) {
        const contentStart = i + m.open.length;
        const closeAt = src.indexOf(m.close, contentStart);
        if (closeAt !== -1 && closeAt > contentStart) {
          matched = { m, contentStart, closeAt };
          break;
        }
      }
    }

    if (matched) {
      const inner = src.slice(matched.contentStart, matched.closeAt);
      const offset = out.length;
      out += inner;
      entities.push({
        type: /** @type {Entity["type"]} */ (matched.m.type),
        offset,
        length: inner.length,
      });
      i = matched.closeAt + matched.m.close.length;
      continue;
    }

    out += src[i];
    i += 1;
  }

  // Auto-link URLs in final text (skip ranges already covered by entities)
  URL_RE.lastIndex = 0;
  let um;
  while ((um = URL_RE.exec(out)) !== null) {
    const offset = um.index;
    const length = um[0].length;
    if (entities.some((e) => rangesOverlap(e.offset, e.length, offset, length))) {
      continue;
    }
    entities.push({
      type: "url",
      offset,
      length,
      url: um[0],
    });
  }

  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: out, entities };
}

/**
 * @param {string} text
 * @param {Entity[] | undefined} entities
 * @returns {DocumentFragment}
 */
export function renderEntities(text, entities) {
  const frag = document.createDocumentFragment();
  const value = String(text ?? "");
  const list = Array.isArray(entities) ? [...entities] : [];
  list.sort((a, b) => a.offset - b.offset || b.length - a.length);

  // Non-overlapping pass: skip overlapping later entities
  /** @type {Entity[]} */
  const flat = [];
  for (const e of list) {
    if (e.offset < 0 || e.length <= 0 || e.offset + e.length > value.length) {
      continue;
    }
    if (flat.some((x) => rangesOverlap(x.offset, x.length, e.offset, e.length))) {
      continue;
    }
    flat.push(e);
  }
  flat.sort((a, b) => a.offset - b.offset);

  let cursor = 0;
  for (const e of flat) {
    if (e.offset > cursor) {
      frag.append(document.createTextNode(value.slice(cursor, e.offset)));
    }
    const slice = value.slice(e.offset, e.offset + e.length);
    frag.append(wrapEntity(e, slice));
    cursor = e.offset + e.length;
  }
  if (cursor < value.length) {
    frag.append(document.createTextNode(value.slice(cursor)));
  }
  if (!frag.childNodes.length) {
    frag.append(document.createTextNode(value));
  }
  return frag;
}

/**
 * Re-wrap stored text + entities into markdown-lite for the compose box.
 * URL entities are left as plain text (auto-detected again on parse).
 * @param {string} text
 * @param {Entity[] | undefined} entities
 * @returns {string}
 */
export function toMarkdownLite(text, entities) {
  const value = String(text ?? "");
  const list = (Array.isArray(entities) ? [...entities] : [])
    .filter((e) => e && e.type !== "url")
    .filter(
      (e) =>
        e.offset >= 0 &&
        e.length > 0 &&
        e.offset + e.length <= value.length,
    )
    .sort((a, b) => b.offset - a.offset || a.length - b.length);

  /** @type {Entity[]} */
  const flat = [];
  for (const e of list) {
    if (flat.some((x) => rangesOverlap(x.offset, x.length, e.offset, e.length))) {
      continue;
    }
    flat.push(e);
  }

  let out = value;
  for (const e of flat) {
    const marker = MARKERS.find((m) => m.type === e.type);
    if (!marker) continue;
    const inner = out.slice(e.offset, e.offset + e.length);
    out =
      out.slice(0, e.offset) +
      marker.open +
      inner +
      marker.close +
      out.slice(e.offset + e.length);
  }
  return out;
}

/**
 * Whether all other members (excluding sender) have acked.
 * @param {string[]} memberPeerIds
 * @param {string} senderPeerId
 * @param {string[]} ackedBy
 */
export function isFullyDelivered(memberPeerIds, senderPeerId, ackedBy) {
  const need = memberPeerIds.filter((p) => p !== senderPeerId);
  if (!need.length) return true;
  const set = new Set(ackedBy || []);
  return need.every((p) => set.has(p));
}

/**
 * @param {Entity} entity
 * @param {string} slice
 */
function wrapEntity(entity, slice) {
  switch (entity.type) {
    case "bold": {
      const el = document.createElement("strong");
      el.textContent = slice;
      return el;
    }
    case "italic": {
      const el = document.createElement("em");
      el.textContent = slice;
      return el;
    }
    case "strike": {
      const el = document.createElement("s");
      el.textContent = slice;
      return el;
    }
    case "code": {
      const el = document.createElement("code");
      el.className = "msg-code";
      el.textContent = slice;
      return el;
    }
    case "url": {
      const el = document.createElement("a");
      el.className = "msg-link";
      el.href = entity.url || slice;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.textContent = slice;
      return el;
    }
    case "spoiler": {
      const el = document.createElement("span");
      el.className = "spoiler";
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.title = "Click to reveal";
      el.textContent = slice;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        el.classList.toggle("is-revealed");
      });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          el.classList.toggle("is-revealed");
        }
      });
      return el;
    }
    default:
      return document.createTextNode(slice);
  }
}

function rangesOverlap(aOff, aLen, bOff, bLen) {
  const aEnd = aOff + aLen;
  const bEnd = bOff + bLen;
  return aOff < bEnd && bOff < aEnd;
}
