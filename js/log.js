const PREFIX = "[ephchat]";

/** @type {boolean} */
let enabled = true;

/** @param {boolean} on */
export function setDebug(on) {
  enabled = Boolean(on);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function log(tag, ...args) {
  if (!enabled) return;
  console.log(PREFIX, tag, ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function warn(tag, ...args) {
  if (!enabled) return;
  console.warn(PREFIX, tag, ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function error(tag, ...args) {
  console.error(PREFIX, tag, ...args);
}
