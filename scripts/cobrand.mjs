// Compose a "Sherwood × <partner>" co-brand post graphic: Sherwood wordmark + a lime
// "×" + the partner's logo, centered over a darkened key-art background.
//   node scripts/cobrand.mjs [bg.png] [out.png] [partnerLogo.svg] [url]
import sharp from "sharp";
import { readFileSync } from "node:fs";

const W = 2048, H = 1152;
const bgPath = process.argv[2] || "brand/announce/sherwood-launch-1.png";
const out = process.argv[3] || "brand/announce/sherwood-x-virtuals.png";
const partnerSvgPath = process.argv[4] || "brand/virtuals-logo.svg";
const url = process.argv[5] || "sherwood.spot";

const LIME = "#CCFF00", MOON = "#EAF2EC";

// Partner SVG → recolor to Moonlight white → hi-res raster → trim padding → resize.
let svg = readFileSync(partnerSvgPath, "utf8").replace(/#236D66/gi, MOON).replace(/#44BCC3/gi, MOON);
const partner = await sharp(Buffer.from(svg), { density: 600 }).trim().resize({ width: 470 }).png().toBuffer();
const pMeta = await sharp(partner).metadata();

// Sherwood wordmark (black-on-transparent) → white via negate(RGB only) → trim whitespace.
const wordmark = await sharp("brand/wordmark.png").negate({ alpha: false }).trim().resize({ width: 640 }).png().toBuffer();
const wmMeta = await sharp(wordmark).metadata();

// Centered horizontal lockup: [wordmark]  ×  [partner]
const gap = 76, xSize = 62;
const totalW = wmMeta.width + gap + xSize + gap + pMeta.width;
const startX = Math.round((W - totalW) / 2);
const midY = Math.round(H * 0.45);
const wmX = startX, wmY = midY - Math.round(wmMeta.height / 2);
const xX = startX + wmMeta.width + gap, yc = midY;
const pX = xX + xSize + gap, pY = midY - Math.round(pMeta.height / 2);

// Darkening scrim + lime "×" (drawn, no font) + partnership label + url (system fonts).
const overlay = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><radialGradient id="v" cx="50%" cy="45%" r="75%">
    <stop offset="0%" stop-color="#0A0E0C" stop-opacity="0.45"/>
    <stop offset="100%" stop-color="#0A0E0C" stop-opacity="0.8"/>
  </radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#v)"/>
  <g stroke="${LIME}" stroke-width="8" stroke-linecap="round">
    <line x1="${xX}" y1="${yc - xSize / 2}" x2="${xX + xSize}" y2="${yc + xSize / 2}"/>
    <line x1="${xX + xSize}" y1="${yc - xSize / 2}" x2="${xX}" y2="${yc + xSize / 2}"/>
  </g>
  <text x="${W / 2}" y="${Math.round(H * 0.63)}" fill="${LIME}" font-family="monospace" font-size="40" letter-spacing="4" text-anchor="middle">${url}</text>
  <text x="${W / 2}" y="${Math.round(H * 0.69)}" fill="${MOON}" font-family="monospace" font-size="24" letter-spacing="6" text-anchor="middle" opacity="0.75">PRIVATE EXCHANGE × VIRTUALS PROTOCOL</text>
</svg>`;

await sharp(bgPath).resize(W, H, { fit: "cover" })
  .composite([
    { input: Buffer.from(overlay) },
    { input: wordmark, left: wmX, top: wmY },
    { input: partner, left: pX, top: pY },
  ])
  .png()
  .toFile(out);
console.log(`wrote ${out}  ${W}x${H}`);
