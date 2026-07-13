// Composite the Sherwood brand lockup (wordmark) + URL onto a background image to
// make a ready-to-post graphic. Brand assets are always used per project convention.
//   node scripts/brand-post.mjs [bg.png] [out.png] [url]
import Jimp from "jimp";

const bgPath = process.argv[2] || "brand/announce/sherwood-launch-1.png";
const outPath = process.argv[3] || "brand/announce/sherwood-post.png";
const url = process.argv[4] || "sherwood.spot";

// Brand palette
const LIME = { r: 204, g: 255, b: 0 };     // #CCFF00 Robinhood Lime
const MOON = { r: 234, g: 242, b: 236 };    // #EAF2EC Moonlight
const COVERT = { r: 10, g: 14, b: 12 };     // #0A0E0C Covert

const bg = await Jimp.read(bgPath);
const W = bg.bitmap.width, H = bg.bitmap.height;

// Dark scrim (left + bottom) so the lockup stays legible over the key art.
bg.scan(0, 0, W, H, function (x, y, idx) {
  const left = Math.max(0, 1 - x / (W * 0.62)) * 0.86;
  const bottom = Math.max(0, (y - H * 0.55) / (H * 0.45)) * 0.72;
  let a = left + bottom * 0.55; if (a > 0.93) a = 0.93;
  this.bitmap.data[idx]     = this.bitmap.data[idx]     * (1 - a) + COVERT.r * a;
  this.bitmap.data[idx + 1] = this.bitmap.data[idx + 1] * (1 - a) + COVERT.g * a;
  this.bitmap.data[idx + 2] = this.bitmap.data[idx + 2] * (1 - a) + COVERT.b * a;
});

// Wordmark (mark + SHERWOOD + PRIVATE EXCHANGE) recolored black -> moonlight white.
const wm = await Jimp.read("brand/wordmark.png");
wm.scan(0, 0, wm.bitmap.width, wm.bitmap.height, function (x, y, idx) {
  if (this.bitmap.data[idx + 3] > 10) { this.bitmap.data[idx] = MOON.r; this.bitmap.data[idx + 1] = MOON.g; this.bitmap.data[idx + 2] = MOON.b; }
});
wm.resize(Math.round(W * 0.42), Jimp.AUTO);
const padX = Math.round(W * 0.06);
const wmY = Math.round(H * 0.40);
bg.composite(wm, padX, wmY);

// URL in lime (print white, then tint to brand lime — jimp fonts are fixed-colour).
const font = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
const urlImg = await new Jimp(760, 110, 0x00000000);
urlImg.print(font, 0, 0, url);
urlImg.scan(0, 0, urlImg.bitmap.width, urlImg.bitmap.height, function (x, y, idx) {
  if (this.bitmap.data[idx + 3] > 10) { this.bitmap.data[idx] = LIME.r; this.bitmap.data[idx + 1] = LIME.g; this.bitmap.data[idx + 2] = LIME.b; }
});
bg.composite(urlImg, padX + 2, wmY + wm.bitmap.height + 54);

await bg.writeAsync(outPath);
console.log(`wrote ${outPath}  ${W}x${H}`);
