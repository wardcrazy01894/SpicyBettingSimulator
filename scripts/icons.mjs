// Regenerates the raster site icons in public/ from public/favicon.svg.
//
//   npm run icons
//
// Uses `sharp`, which is not a direct dependency: miniflare (pulled in by
// wrangler) depends on it, so it is always in node_modules alongside the tools
// this repo already needs. The outputs are committed, so this only has to be
// re-run when favicon.svg changes.
//
//   favicon-32.png / favicon-192.png / favicon-512.png  manifest + tab icons
//   apple-touch-icon.png (180x180)                       iOS home screen
//   favicon.ico                                          legacy fallback; an ICO
//                                                        container holding the
//                                                        32x32 PNG (valid since
//                                                        Windows Vista)
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const svg = readFileSync('public/favicon.svg');

/** @param {number} size */
async function png(size) {
  return sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
}

for (const size of [32, 192, 512]) {
  writeFileSync(`public/favicon-${size}.png`, await png(size));
}
writeFileSync('public/apple-touch-icon.png', await png(180));

const p32 = await png(32);
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
writeFileSync('public/favicon.ico', Buffer.concat([header, p32]));

console.log('public/ icons regenerated');
