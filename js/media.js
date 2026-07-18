import {
  MAX_IMAGE_BYTES,
  MEDIA_CHUNK_BYTES,
  MEDIA_JPEG_QUALITY,
  MEDIA_MAX_DIMENSION,
} from "./constants.js";
import { mintId } from "./ids.js";

/**
 * @typedef {{
 *   blob: Blob,
 *   mime: string,
 *   width: number,
 *   height: number,
 *   size: number,
 *   duration?: number,
 * }} CompressedImage
 *
 * @typedef {{
 *   blob: Blob,
 *   mime: string,
 *   width: number,
 *   height: number,
 *   duration: number,
 *   size: number,
 * }} PreparedVideo
 */

/** @returns {string} */
export function mintMediaId() {
  return mintId("med");
}

/**
 * Compress an image file/blob via canvas.
 * @param {Blob | File} input
 * @returns {Promise<CompressedImage>}
 */
export async function compressImage(input) {
  if (!(input instanceof Blob)) {
    throw new Error("Expected image blob");
  }
  if (!input.type.startsWith("image/") && input.type !== "") {
    throw new Error("Not an image");
  }

  const bitmap = await createImageBitmap(input);
  try {
    let { width, height } = bitmap;
    const maxEdge = Math.max(width, height);
    if (maxEdge > MEDIA_MAX_DIMENSION) {
      const scale = MEDIA_MAX_DIMENSION / maxEdge;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);

    let blob = await canvasToBlob(canvas, "image/jpeg", MEDIA_JPEG_QUALITY);
    let mime = "image/jpeg";

    // Prefer WebP when smaller and supported
    try {
      const webp = await canvasToBlob(canvas, "image/webp", MEDIA_JPEG_QUALITY);
      if (webp && webp.size > 0 && webp.size < blob.size) {
        blob = webp;
        mime = "image/webp";
      }
    } catch {
      /* jpeg only */
    }

    if (blob.size > MAX_IMAGE_BYTES) {
      const q2 = Math.max(0.45, MEDIA_JPEG_QUALITY - 0.25);
      blob = await canvasToBlob(canvas, "image/jpeg", q2);
      mime = "image/jpeg";
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image too large after compress (${blob.size} > ${MAX_IMAGE_BYTES})`,
      );
    }

    return { blob, mime, width, height, size: blob.size };
  } finally {
    bitmap.close?.();
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} quality
 * @returns {Promise<Blob>}
 */
function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (!b) reject(new Error("Encode failed"));
        else resolve(b);
      },
      type,
      quality,
    );
  });
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>} base64url (no data: prefix)
 */
export async function blobToBase64Url(blob) {
  const buf = await blob.arrayBuffer();
  return uint8ToBase64Url(new Uint8Array(buf));
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function uint8ToBase64Url(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} b64url
 * @returns {Uint8Array}
 */
export function base64UrlToUint8Array(b64url) {
  const pad = b64url.length % 4 === 0 ? "" : "=".repeat(4 - (b64url.length % 4));
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {Uint8Array} u8
 * @param {number} [size]
 * @returns {Uint8Array[]}
 */
export function chunkUint8(u8, size = MEDIA_CHUNK_BYTES) {
  /** @type {Uint8Array[]} */
  const parts = [];
  for (let i = 0; i < u8.length; i += size) {
    parts.push(u8.subarray(i, i + size));
  }
  return parts.length ? parts : [new Uint8Array(0)];
}

/**
 * @param {Blob} blob
 * @param {number} [chunkSize]
 * @returns {Promise<string[]>} base64url chunks
 */
export async function blobToBase64Chunks(blob, chunkSize = MEDIA_CHUNK_BYTES) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  return chunkUint8(u8, chunkSize).map((c) => uint8ToBase64Url(c));
}

/**
 * Encode one slice of a blob as base64url (avoids loading whole file into RAM).
 * @param {Blob} blob
 * @param {number} offset
 * @param {number} [chunkSize]
 */
export async function blobSliceToBase64Url(
  blob,
  offset,
  chunkSize = MEDIA_CHUNK_BYTES,
) {
  const slice = blob.slice(offset, offset + chunkSize);
  const u8 = new Uint8Array(await slice.arrayBuffer());
  return uint8ToBase64Url(u8);
}

/** @param {number} size @param {number} [chunkSize] */
export function mediaChunkCount(size, chunkSize = MEDIA_CHUNK_BYTES) {
  const n = Math.ceil((Number(size) || 0) / chunkSize);
  return n > 0 ? n : 1;
}

/**
 * Reassemble chunks into a Blob.
 * @param {string[]} b64Chunks
 * @param {string} mime
 * @returns {Blob}
 */
export function blobFromBase64Chunks(b64Chunks, mime) {
  const parts = b64Chunks.map((c) => base64UrlToUint8Array(c));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return new Blob([out], { type: mime || "application/octet-stream" });
}

/**
 * Prepare video for send (no re-encode, no size reject).
 * Metadata probe is time-capped so huge files do not hang the send button.
 * @param {Blob | File} input
 * @returns {Promise<PreparedVideo>}
 */
export async function prepareVideo(input) {
  if (!(input instanceof Blob)) {
    throw new Error("Expected video blob");
  }
  if (!input.type.startsWith("video/") && input.type !== "") {
    throw new Error("Not a video");
  }

  const mime = input.type || "video/mp4";
  const url = URL.createObjectURL(input);
  try {
    const meta = await readVideoMetadata(url, 2500);
    return {
      blob: input,
      mime,
      width: meta.width || 0,
      height: meta.height || 0,
      duration: Number.isFinite(meta.duration) ? meta.duration : 0,
      size: input.size,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** @param {number} n */
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ duration: number, width: number, height: number }>}
 */
function readVideoMetadata(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let done = false;
    const finish = (meta) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(meta);
    };
    const timer = setTimeout(() => {
      finish({ duration: 0, width: 0, height: 0 });
    }, timeoutMs);
    video.onloadedmetadata = () => {
      finish({
        duration: video.duration,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
      });
    };
    video.onerror = () => {
      finish({ duration: 0, width: 0, height: 0 });
    };
    video.src = url;
  });
}

/**
 * ~1s WebM via canvas + MediaRecorder for fixture mode.
 * @param {string} [label]
 * @returns {Promise<PreparedVideo | null>}
 */
export async function makeFixtureVideo(label = "Clip") {
  if (typeof MediaRecorder === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const stream = canvas.captureStream(24);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
    ? "video/webm;codecs=vp8"
    : MediaRecorder.isTypeSupported("video/webm")
      ? "video/webm"
      : "";
  if (!mime) {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }

  /** @type {Blob[]} */
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };

  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(undefined);
    recorder.onerror = () => reject(new Error("MediaRecorder failed"));
  });

  recorder.start(100);
  const start = performance.now();
  await new Promise((resolve) => {
    const draw = (now) => {
      const t = (now - start) / 1000;
      ctx.fillStyle = `hsl(${(t * 120) % 360} 55% 42%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 28px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label.slice(0, 16), canvas.width / 2, canvas.height / 2);
      if (t < 1.05) requestAnimationFrame(draw);
      else resolve(undefined);
    };
    requestAnimationFrame(draw);
  });
  recorder.stop();
  stream.getTracks().forEach((t) => t.stop());
  await done;

  const blob = new Blob(chunks, { type: mime.split(";")[0] || "video/webm" });
  if (!blob.size) return null;
  return {
    blob,
    mime: blob.type || "video/webm",
    width: canvas.width,
    height: canvas.height,
    duration: 1,
    size: blob.size,
  };
}

/**
 * Tiny labeled JPEG for fixture mode (no network).
 * @param {string} label
 * @param {string} [color]
 * @returns {Promise<CompressedImage>}
 */
export async function makeFixtureImage(label, color = "#3a7bd5") {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, canvas.height - 48, canvas.width, 48);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label.slice(0, 24), canvas.width / 2, canvas.height / 2);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.85);
  return {
    blob,
    mime: "image/jpeg",
    width: canvas.width,
    height: canvas.height,
    size: blob.size,
  };
}
