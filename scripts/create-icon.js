import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dimension = 256;
const raw = Buffer.alloc((dimension * 4 + 1) * dimension);
const palette = { grass: [117, 172, 69], light: [161, 212, 107], dark: [66, 107, 49], letter: [245, 245, 222] };
const sprout = [[17, 7, 8, 5], [17, 12, 5, 3], [7, 10, 7, 5], [11, 13, 6, 5], [14, 15, 4, 10]];
for (let row = 0; row < dimension; row++) {
  for (let column = 0; column < dimension; column++) {
    const gridRow = Math.floor(row / 8);
    const gridColumn = Math.floor(column / 8);
    let color;
    if (gridRow >= 2 && gridRow < 30 && gridColumn >= 2 && gridColumn < 30) color = palette.grass;
    if (color && (gridRow < 7 || gridColumn < 7)) color = palette.light;
    if (color && ((gridColumn >= 25 && gridRow >= 7) || (gridRow >= 25 && gridColumn >= 7))) color = palette.dark;
    if (sprout.some(([left, top, width, height]) => gridColumn >= left && gridColumn < left + width && gridRow >= top && gridRow < top + height)) color = palette.letter;
    if (color) {
      const offset = row * (dimension * 4 + 1) + 1 + column * 4;
      raw.set([...color, 255], offset);
    }
  }
}

function crc32(buffer) {
  let checksum = 0xffffffff;
  for (const value of buffer) {
    checksum ^= value;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([header, payload, checksum]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(dimension, 0);
header.writeUInt32BE(dimension, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);
const assets = new URL('../desktop/assets/', import.meta.url);
await mkdir(assets, { recursive: true });
await writeFile(new URL('icon.png', assets), png);
await writeFile(new URL('icon.ico', assets), Buffer.concat([icoHeader, png]));
process.stdout.write(`Desktop icons created: ${fileURLToPath(assets)}\n`);
