// Regenerates the raster site icons in public/ from public/favicon.svg.
//
//   npm run icons
//
// `sharp` is NOT a declared dependency and that is a deliberate trade-off, not
// an oversight: miniflare (pulled in by wrangler) depends on it, so it is in
// node_modules on every machine that can run this repo's tests, and adding it
// to package.json for a script that runs a few times a year did not seem worth
// a direct dependency (CLAUDE.md: "raise it, don't add unilaterally"). If a
// wrangler bump ever drops it this script fails loudly with
// ERR_MODULE_NOT_FOUND and the committed PNGs keep shipping unchanged. Promote
// it to a devDependency the day that happens.
//
// The SVG contains no <text>: the "$" is a stroked path, so the rasters do not
// depend on which fonts the machine running this has installed, and the file
// can be regenerated anywhere with byte-identical results.
//
//   favicon-32.png / favicon-192.png / favicon-512.png  manifest + tab icons
//   apple-touch-icon.png (180x180)                       iOS home screen. iOS
//                                                        masks the corners
//                                                        itself and paints
//                                                        transparency BLACK, so
//                                                        this one is rendered
//                                                        full-bleed (no rounded
//                                                        corners).
//   favicon.ico                                          legacy fallback; an ICO
//                                                        container holding the
//                                                        32x32 PNG (valid since
//                                                        Windows Vista)
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const svg = readFileSync(new URL('favicon.svg', `file://${publicDir}`), 'utf8');
// The same artwork on a square background: only the rounded corners differ.
const squareSvg = svg.replace(/ rx="14"/, '');
if (squareSvg === svg)
  throw new Error('favicon.svg: expected the background rect to carry rx="14"');

/** @param {string} source @param {number} size */
async function png(source, size) {
  return sharp(Buffer.from(source), { density: 384 }).resize(size, size).png().toBuffer();
}

for (const size of [32, 192, 512]) {
  writeFileSync(`${publicDir}favicon-${String(size)}.png`, await png(svg, size));
}
writeFileSync(`${publicDir}apple-touch-icon.png`, await png(squareSvg, 180));

const p32 = await png(svg, 32);
const header = Buffer.alloc(6 + 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count
header[6] = 32; // width
header[7] = 32; // height
header[8] = 0; // palette size
header[9] = 0; // reserved
header.writeUInt16LE(1, 10); // colour planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(p32.length, 14); // image size
header.writeUInt32LE(22, 18); // image offset (6 + 16)
writeFileSync(`${publicDir}favicon.ico`, Buffer.concat([header, p32]));

console.log('public/ icons regenerated');
