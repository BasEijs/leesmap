// Generates a clean typographic cover image (JPEG) for an EPUB, so the reader
// shows a real cover instead of scraping text off the first page. Deliberately
// high-contrast black-on-white with generous type: that's what survives a small
// greyscale e-ink panel and its thumbnail rendering.
//
// Fonts are bundled under src/fonts (PT Serif, OFL) and registered by explicit
// family names, so the output is identical in local dev and in the slim
// container — which ships no system fonts of its own.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

const fontsDir = join(dirname(fileURLToPath(import.meta.url)), 'fonts');
const BOLD = 'LeesmapSerifBold';
const REGULAR = 'LeesmapSerif';

// Register once. registerFromPath is a no-op if the family is already present,
// but guard anyway so repeated builds don't re-read the files.
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  GlobalFonts.registerFromPath(join(fontsDir, 'PTSerif-Bold.ttf'), BOLD);
  GlobalFonts.registerFromPath(join(fontsDir, 'PTSerif-Regular.ttf'), REGULAR);
  fontsReady = true;
}

const W = 1200;
const H = 1600;
const MARGIN = 110;
const INK = '#141414';
// Darker than a typical "muted grey" web color: at cover-thumbnail sizes an
// e-ink panel dithers mid-greys into near-invisibility, so secondary text
// needs more contrast than it would on a screen to stay legible.
const MUTED = '#333333';
const PAPER = '#ffffff';

// Draw letter-spaced, centred caps (for the small "DE CORRESPONDENT" label).
function drawSpacedCaps(ctx, text, cx, y, size, tracking) {
  ctx.font = `${size}px ${REGULAR}`;
  const chars = [...text.toUpperCase()];
  const widths = chars.map((c) => ctx.measureText(c).width + tracking);
  const total = widths.reduce((a, b) => a + b, 0) - tracking;
  let x = cx - total / 2;
  ctx.textAlign = 'left';
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], x, y);
    x += widths[i];
  }
}

// Draw a circular, desaturated portrait centred at (cx, cy) with radius r —
// the same round avatar the web grid shows. Greyscale keeps it honest to how
// the e-ink panel will actually render it. `img` is a decoded Image; if null we
// draw an initials monogram instead (matching the web's placeholder).
function drawAvatar(ctx, img, cx, cy, r, initials) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    // object-fit: cover — scale so the shorter side fills the circle.
    const s = Math.max((2 * r) / img.width, (2 * r) / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    ctx.fillStyle = '#ececec';
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.fillStyle = MUTED;
    ctx.font = `${Math.round(r * 0.9)}px ${BOLD}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials || '?', cx, cy + 2);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  // Desaturate the portrait to true greyscale (luminance), matching e-ink.
  if (img) {
    const x0 = Math.floor(cx - r);
    const y0 = Math.floor(cy - r);
    const d = Math.ceil(2 * r);
    const region = ctx.getImageData(x0, y0, d, d);
    const px = region.data;
    for (let i = 0; i < px.length; i += 4) {
      const g = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(region, x0, y0);
  }

  // Thin ring, like the web avatar's border.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.lineWidth = 4;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

// Draw a centred row of small round portraits (a selection's authors). When
// there are more than fit, the last circle becomes a "+N" overflow chip.
// Returns the row's height so the caller can advance below it.
async function drawAvatarRow(ctx, portraits, cx, top) {
  const r = 54;
  const gap = 26;
  const step = 2 * r + gap;
  const MAX = 6;

  let items = portraits;
  let overflow = 0;
  if (portraits.length > MAX) {
    items = portraits.slice(0, MAX - 1);
    overflow = portraits.length - items.length;
  }
  const n = items.length + (overflow ? 1 : 0);
  const totalW = n * 2 * r + (n - 1) * gap;
  let x = cx - totalW / 2 + r;
  const cy = top + r;

  for (const it of items) {
    let img = null;
    if (it.avatar) {
      try {
        img = await loadImage(it.avatar);
      } catch {
        img = null;
      }
    }
    drawAvatar(ctx, img, x, cy, r, initialsOf(it.author));
    x += step;
  }

  if (overflow) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ececec';
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = MUTED;
    ctx.font = `${Math.round(r * 0.62)}px ${BOLD}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${overflow}`, x, cy + 2);
    ctx.textBaseline = 'alphabetic';
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  return 2 * r;
}

// Two-letter initials from a name ("Jesse Frederik" -> "JF").
function initialsOf(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

// Greedy word-wrap `text` at `font` so no line exceeds `maxWidth`.
function wrap(ctx, text, font, maxWidth) {
  ctx.font = font;
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const trial = line ? `${line} ${word}` : word;
    if (ctx.measureText(trial).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Pick the largest title size (within [min,max]) that wraps to <= maxLines and
// fits the column width. Long headlines shrink instead of overflowing.
function fitTitle(ctx, text, { maxWidth, maxLines, min, max }) {
  for (let size = max; size >= min; size -= 4) {
    const lines = wrap(ctx, text, `${size}px ${BOLD}`, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = min;
  return { size, lines: wrap(ctx, text, `${size}px ${BOLD}`, maxWidth).slice(0, maxLines) };
}

/**
 * Build a cover PNG.
 * @param {object} o
 * @param {string} [o.kicker]   small caps label at the top ("De Correspondent")
 * @param {string}  o.title     main headline / book title
 * @param {string} [o.subtitle] author, or e.g. "12 artikelen"
 * @param {string} [o.footer]   date line at the bottom
 * @param {Buffer} [o.avatar]   correspondent portrait bytes; drawn as a circle
 * @param {boolean}[o.portrait] force showing/hiding the single portrait circle
 *                              (defaults to: show when an avatar is given)
 * @param {{avatar?: Buffer, author?: string}[]} [o.portraits]
 *                              multiple authors, drawn as a row of small circles
 *                              (for selection/bundle covers); overrides the
 *                              single portrait
 * @returns {Promise<Buffer>} JPEG bytes
 */
export async function coverImage({
  kicker = 'De Correspondent',
  title,
  subtitle,
  footer,
  avatar,
  portrait,
  portraits,
} = {}) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Decode the portrait up front (best-effort — a bad image just drops it).
  let avatarImg = null;
  if (avatar) {
    try {
      avatarImg = await loadImage(avatar);
    } catch {
      avatarImg = null;
    }
  }

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // Thin frame — reads as "designed" rather than blank.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.strokeRect(MARGIN * 0.55, MARGIN * 0.55, W - MARGIN * 1.1, H - MARGIN * 1.1);

  const cx = W / 2;
  const colW = W - MARGIN * 2;
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';

  // Kicker + rule near the top.
  if (kicker) {
    drawSpacedCaps(ctx, kicker, cx, MARGIN + 70, 38, 8);
    ctx.beginPath();
    ctx.moveTo(cx - 90, MARGIN + 110);
    ctx.lineTo(cx + 90, MARGIN + 110);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  // A single portrait (one author) or a row of portraits (a selection with
  // several authors) sits between the title and subtitle. Either way we reserve
  // vertical space: the title gets one fewer line and sits a touch higher.
  const hasRow = Array.isArray(portraits) && portraits.length > 0;
  const showPortrait = !hasRow && (portrait ?? Boolean(avatar));
  const reserve = hasRow || showPortrait;

  // Title, auto-sized and centred in the upper-middle band.
  const { size, lines } = fitTitle(ctx, title || 'Zonder titel', {
    maxWidth: colW,
    maxLines: reserve ? 4 : 5,
    min: 56,
    max: 118,
  });
  ctx.fillStyle = INK;
  ctx.font = `${size}px ${BOLD}`;
  ctx.textAlign = 'center';
  const lineH = size * 1.16;
  const blockH = lineH * lines.length;
  let y = H * (reserve ? 0.36 : 0.42) - blockH / 2 + size;
  for (const line of lines) {
    ctx.fillText(line, cx, y);
    y += lineH;
  }
  y += 20; // gap below the title block

  // Correspondent portrait(s), like the round avatars in the web grid.
  if (hasRow) {
    y += (await drawAvatarRow(ctx, portraits, cx, y)) + 30;
  } else if (showPortrait) {
    const r = 96;
    drawAvatar(ctx, avatarImg, cx, y + r, r, initialsOf(subtitle));
    y += 2 * r + 30;
  }

  // Subtitle (author / count) below the title (and portrait, if any).
  if (subtitle) {
    ctx.font = `46px ${REGULAR}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.fillText(subtitle, cx, y + 24);
  }

  // Footer date, with a short rule above it.
  if (footer) {
    ctx.beginPath();
    ctx.moveTo(cx - 60, H - MARGIN - 96);
    ctx.lineTo(cx + 60, H - MARGIN - 96);
    ctx.lineWidth = 2;
    ctx.strokeStyle = MUTED;
    ctx.stroke();
    ctx.font = `38px ${REGULAR}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.fillText(footer, cx, H - MARGIN - 44);
  }

  // JPEG, not PNG: PocketBook's sleep-screen ("show the current book's cover
  // when locked") only renders JPEG covers. A PNG shows in the library grid but
  // the lock screen silently falls back to the default wallpaper. High quality
  // keeps the crisp black-on-white type clean on the e-ink panel.
  return canvas.toBuffer('image/jpeg', 92);
}

// A `File` is what epub-gen-memory's `cover` option accepts directly; it derives
// the media type from the `.jpg` name. This keeps cover bytes in-process (no
// round-trip through the /media route).
export async function coverFile(opts) {
  return new File([await coverImage(opts)], 'cover.jpg', { type: 'image/jpeg' });
}
