export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export const todayISO = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
};

export const daysSince = (iso) => {
  if (!iso) return Infinity;
  return Math.round((new Date(todayISO()) - new Date(iso)) / 86400000);
};

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.innerHTML = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
}
export const hideToast = () => ($('#toast').hidden = true);

export const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

export async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}

async function loadBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Older engines: fall back to an <img>
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

const canvasToBlob = (canvas, quality = 0.82) =>
  new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));

/** Downscale a photo so the long edge is at most `max` px. */
export async function resizeImage(blob, max = 1024) {
  const bmp = await loadBitmap(blob);
  const w = bmp.width, h = bmp.height;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return canvasToBlob(c);
}

/** Crop to a normalised [x0,y0,x1,y1] box with padding, returned at 3:4-ish. */
export async function cropImage(blob, box, pad = 0.06) {
  if (!Array.isArray(box) || box.length !== 4 || box.some((n) => typeof n !== 'number' || Number.isNaN(n))) return blob;
  let [x0, y0, x1, y1] = box.map((n) => Math.max(0, Math.min(1, n)));
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  if ((x1 - x0) < 0.08 || (y1 - y0) < 0.08) return blob; // implausible box
  if ((x1 - x0) * (y1 - y0) > 0.85) return blob; // basically the whole frame
  const bmp = await loadBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const px = Math.max(0, (x0 - pad) * W), py = Math.max(0, (y0 - pad) * H);
  const pw = Math.min(W, (x1 + pad) * W) - px, ph = Math.min(H, (y1 + pad) * H) - py;
  const c = document.createElement('canvas');
  c.width = Math.round(pw);
  c.height = Math.round(ph);
  c.getContext('2d').drawImage(bmp, px, py, pw, ph, 0, 0, c.width, c.height);
  return canvasToBlob(c, 0.85);
}

const NAMED = {
  black: [25, 25, 25], white: [240, 240, 238], grey: [128, 128, 128], charcoal: [60, 62, 66],
  navy: [30, 40, 80], blue: [50, 90, 180], 'light blue': [150, 185, 225], denim: [80, 105, 140],
  red: [190, 35, 40], maroon: [110, 25, 35], pink: [230, 150, 175], orange: [230, 120, 40],
  yellow: [235, 205, 60], mustard: [200, 155, 40], green: [50, 130, 70], olive: [110, 110, 50],
  teal: [30, 120, 125], purple: [110, 60, 140], brown: [110, 70, 40], tan: [190, 150, 105],
  beige: [215, 195, 165], cream: [240, 230, 205], khaki: [175, 160, 115],
};

/** Best-effort dominant colour name from the centre of the photo (used when AI is off). */
export async function dominantColorName(blob) {
  try {
    const bmp = await loadBitmap(blob);
    const c = document.createElement('canvas');
    c.width = c.height = 48;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const sw = bmp.width * 0.5, sh = bmp.height * 0.5;
    ctx.drawImage(bmp, bmp.width * 0.25, bmp.height * 0.25, sw, sh, 0, 0, 48, 48);
    const { data } = ctx.getImageData(0, 0, 48, 48);
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const k = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const rgb = [(top >> 8 & 15) * 16 + 8, (top >> 4 & 15) * 16 + 8, (top & 15) * 16 + 8];
    let best = 'grey', bestD = Infinity;
    for (const [name, v] of Object.entries(NAMED)) {
      const d = (v[0] - rgb[0]) ** 2 * 0.3 + (v[1] - rgb[1]) ** 2 * 0.59 + (v[2] - rgb[2]) ** 2 * 0.11;
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  } catch {
    return '';
  }
}

/** Object URLs for blobs, cached so grids don't leak. */
const urlCache = new WeakMap();
export function blobURL(blob) {
  if (!blob) return '';
  let u = urlCache.get(blob);
  if (!u) { u = URL.createObjectURL(blob); urlCache.set(blob, u); }
  return u;
}

export function openSheet(el) {
  if (!el.open) el.showModal();
}
export function closeSheet(el) {
  if (el.open) el.close();
}
