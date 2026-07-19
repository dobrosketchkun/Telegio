/**
 * Minimal Twemoji renderer: draws emoji using Twitter's open-source Twemoji
 * assets from a pinned jsDelivr CDN (jdecked fork), with graceful fallback to
 * the native OS emoji when the image can't load (e.g. CDN blocked / offline).
 *
 * No dependency on the twemoji library — we only need the codepoint filename
 * rule and a small emoji-run scanner.
 */

// Pinned like js/trystero.js. jdecked/twemoji is the maintained fork of the
// (archived) twitter/twemoji asset set.
export const TWEMOJI_BASE =
  "https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/";

const ZWJ = "\u200d";
const VS16 = /\uFE0F/g;

/**
 * Twemoji filename rule: drop U+FE0F (variation selector) unless the sequence
 * contains a ZWJ, then join the remaining codepoints with "-".
 * @param {string} emoji
 * @returns {string}
 */
export function toCodePoints(emoji) {
  const normalized = emoji.indexOf(ZWJ) < 0 ? emoji.replace(VS16, "") : emoji;
  const out = [];
  let high = 0;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    if (high) {
      out.push((0x10000 + ((high - 0xd800) << 10) + (c - 0xdc00)).toString(16));
      high = 0;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      high = c;
    } else {
      out.push(c.toString(16));
    }
  }
  return out.join("-");
}

/**
 * An <img> drawing the emoji via Twemoji, falling back to the native glyph.
 * @param {string} emoji
 * @returns {HTMLImageElement}
 */
export function emojiImg(emoji) {
  const img = document.createElement("img");
  img.className = "twemoji";
  img.alt = emoji;
  img.draggable = false;
  img.loading = "lazy";
  img.src = TWEMOJI_BASE + toCodePoints(emoji) + ".svg";
  img.addEventListener(
    "error",
    () => {
      img.replaceWith(document.createTextNode(emoji));
    },
    { once: true },
  );
  return img;
}

// Matches: flag pairs, keycaps, then any pictographic base plus its
// modifiers/ZWJ sequence.
const EMOJI_SOURCE =
  "[\\u{1F1E6}-\\u{1F1FF}]{2}" +
  "|[#*0-9]\\uFE0F?\\u20E3" +
  "|\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic}|[\\u{1F3FB}-\\u{1F3FF}])*";

/** @param {Text} textNode */
function replaceInTextNode(textNode) {
  const text = textNode.nodeValue || "";
  const re = new RegExp(EMOJI_SOURCE, "gu");
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  let found = false;
  while ((m = re.exec(text)) !== null) {
    found = true;
    if (m.index > last) {
      frag.append(document.createTextNode(text.slice(last, m.index)));
    }
    frag.append(emojiImg(m[0]));
    last = m.index + m[0].length;
  }
  if (!found) return;
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  textNode.replaceWith(frag);
}

/**
 * Replace emoji inside all text nodes of `root` with Twemoji images. Safe to
 * call on freshly built DOM; skips content already inside a .twemoji image.
 * @param {Node | null | undefined} root
 */
export function twemojify(root) {
  if (!root || typeof document === "undefined") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  /** @type {Text[]} */
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.trim()) nodes.push(/** @type {Text} */ (n));
  }
  for (const textNode of nodes) replaceInTextNode(textNode);
}
