// Generates a clean typographic cover image (PNG) for an EPUB, so the reader
// shows a real cover instead of scraping text off the first page. Deliberately
// high-contrast black-on-white with generous type: that's what survives a small
// greyscale e-ink panel and its thumbnail rendering.
//
// Fonts are bundled under src/fonts (PT Serif, OFL) and registered by explicit
// family names, so the output is identical in local dev and in the slim
// container — which ships no system fonts of its own.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

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
const MUTED = '#5c5c5c';
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
 * @returns {Buffer} PNG bytes
 */
export function coverImage({ kicker = 'De Correspondent', title, subtitle, footer } = {}) {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

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
    drawSpacedCaps(ctx, kicker, cx, MARGIN + 70, 34, 8);
    ctx.beginPath();
    ctx.moveTo(cx - 90, MARGIN + 110);
    ctx.lineTo(cx + 90, MARGIN + 110);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  // Title, auto-sized and centred in the upper-middle band.
  const { size, lines } = fitTitle(ctx, title || 'Zonder titel', {
    maxWidth: colW,
    maxLines: 5,
    min: 56,
    max: 118,
  });
  ctx.fillStyle = INK;
  ctx.font = `${size}px ${BOLD}`;
  ctx.textAlign = 'center';
  const lineH = size * 1.16;
  const blockH = lineH * lines.length;
  let y = H * 0.42 - blockH / 2 + size;
  for (const line of lines) {
    ctx.fillText(line, cx, y);
    y += lineH;
  }

  // Subtitle (author / count) just below the title block.
  if (subtitle) {
    ctx.font = `40px ${REGULAR}`;
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
    ctx.font = `34px ${REGULAR}`;
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.fillText(footer, cx, H - MARGIN - 44);
  }

  return canvas.toBuffer('image/png');
}

// A `File` is what epub-gen-memory's `cover` option accepts directly; it derives
// the media type from the `.png` name. This keeps cover bytes in-process (no
// round-trip through the /media route).
export function coverFile(opts) {
  return new File([coverImage(opts)], 'cover.png', { type: 'image/png' });
}
