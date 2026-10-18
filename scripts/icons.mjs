// Draws the toolbar icons (rounded square, white "< ✓ >") without any image library.
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const segs = [
  [[8, 7], [3.5, 12]], [[3.5, 12], [8, 17]],
  [[16, 7], [20.5, 12]], [[20.5, 12], [16, 17]],
  [[10, 12.5], [11.8, 14.3]], [[11.8, 14.3], [15, 10.5]],
];
function distSeg(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function inRounded(x, y, r) { const cx = Math.max(r, Math.min(24 - r, x)), cy = Math.max(r, Math.min(24 - r, y)); return Math.hypot(x - cx, y - cy) <= r; }
for (const size of [16, 32, 48, 128]) {
  const rgba = Buffer.alloc(size * size * 4);
  const S = 4;
  const stroke = size <= 16 ? 1.25 : 1.0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const px = ((x + (sx + 0.5) / S) / size) * 24, py = ((y + (sy + 0.5) / S) / size) * 24;
      if (inRounded(px, py, 5)) { bg++; if (segs.some((s) => distSeg(px, py, s) <= stroke)) fg++; }
    }
    const a = bg / (S * S), f = bg ? fg / bg : 0;
    const base = [0x1f, 0x6f, 0xeb];
    const i = (y * size + x) * 4;
    rgba[i] = Math.round(base[0] + (255 - base[0]) * f);
    rgba[i + 1] = Math.round(base[1] + (255 - base[1]) * f);
    rgba[i + 2] = Math.round(base[2] + (255 - base[2]) * f);
    rgba[i + 3] = Math.round(a * 255);
  }
  writeFileSync(new URL(`../browser/static/icons/icon${size}.png`, import.meta.url), png(size, rgba));
}
console.log('icons written');
