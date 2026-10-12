import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function pixelBitmap(width, height, rectangles, background = '#fffef5') {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bitmap = Buffer.alloc(54 + stride * height);
  bitmap.write('BM');
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(width, 18);
  bitmap.writeInt32LE(height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(stride * height, 34);
  for (const [left, top, columns, rows, color] of [[0, 0, width, height, background], ...rectangles]) {
    const rgb = Number.parseInt(color.slice(1), 16);
    for (let row = Math.max(0, top); row < Math.min(height, top + rows); row++) {
      for (let column = Math.max(0, left); column < Math.min(width, left + columns); column++) {
        const offset = 54 + (height - row - 1) * stride + column * 3;
        bitmap[offset] = rgb & 255;
        bitmap[offset + 1] = rgb >>> 8 & 255;
        bitmap[offset + 2] = rgb >>> 16 & 255;
      }
    }
  }
  return bitmap;
}

function pixelMark(left, top, scale) {
  const sprout = [[17, 7, 8, 5], [17, 12, 5, 3], [7, 10, 7, 5], [11, 13, 6, 5], [14, 15, 4, 10]];
  return [[2, 2, 28, 28, '#75ac45'], [2, 2, 28, 5, '#a1d46b'], [2, 2, 5, 28, '#a1d46b'], [25, 7, 5, 23, '#426b31'], [7, 25, 18, 5, '#426b31'], ...sprout.map(rectangle => [...rectangle, '#f5f5de'])].map(([x, y, width, height, color]) => [left + Math.round(x * scale), top + Math.round(y * scale), Math.round((x + width) * scale) - Math.round(x * scale), Math.round((y + height) * scale) - Math.round(y * scale), color]);
}

export async function createInstallerAssets(directory) {
  await mkdir(directory, { recursive: true });
  const scene = [[0,0,180,220,'#eef4e5'],[0,0,180,4,'#88ad65'],...pixelMark(14,16,1.25),[134,38,20,20,'#f6c95a'],[134,38,20,4,'#ffe9a0'],[16,91,38,8,'#fffefa'],[24,84,20,7,'#fffefa'],[13,151,153,34,'#c6e4d5'],[29,138,48,30,'#c6e4d5'],[111,130,32,38,'#c6e4d5'],[23,164,133,23,'#9ac475'],[38,168,111,28,'#b48c61'],[38,191,111,7,'#92704e'],[30,160,126,12,'#79a94b'],[30,160,126,5,'#a5cd6b'],[48,178,13,7,'#c5a37a'],[80,173,9,9,'#c5a37a'],[124,184,13,5,'#c5a37a'],[64,126,11,36,'#806344'],[64,126,5,36,'#a17d50'],[42,106,58,28,'#4a793e'],[48,126,39,16,'#4a793e'],[46,94,45,14,'#6eaa4c'],[36,108,68,20,'#6eaa4c'],[48,124,42,10,'#6eaa4c'],[46,94,45,7,'#94c565'],[36,108,18,7,'#94c565'],[62,119,12,9,'#81b556'],[81,103,12,8,'#81b556'],[119,141,18,20,'#f4e4b8'],[115,135,26,7,'#bd954f'],[126,147,6,7,'#ddb364']];
  for (let column = 0; column < 180; column += 12) scene.push([column,212,12,8,column % 24 ? '#c6d6ac' : '#a4bd85']);
  await writeFile(path.join(directory, 'scene.bmp'), pixelBitmap(180, 220, scene));
  await writeFile(path.join(directory, 'sidebar.bmp'), pixelBitmap(164, 314, scene.map(([left, top, width, height, color]) => [left - 8, top + 45, width, height, color]), '#eef4e5'));
  await writeFile(path.join(directory, 'header.bmp'), pixelBitmap(150, 57, [...pixelMark(16,14,0.875),[52,24,80,4,'#a4bd85'],[52,32,54,3,'#d5dfc4']]));
}

export async function removalManifest(directory) {
  const files = [];
  const folders = [];
  async function visit(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (/["$`\r\n]/.test(entry.name) || entry.isSymbolicLink()) throw new Error(`Unsafe installer payload entry: ${entry.name}`);
      const location = path.join(relative, entry.name);
      if (entry.isDirectory()) { folders.push(location); await visit(location); }
      else if (entry.isFile()) files.push(location);
      else throw new Error(`Unsupported installer payload entry: ${entry.name}`);
    }
  }
  await visit('');
  if (!files.includes('Harness Studio.exe') || !files.includes(path.join('resources', 'app.asar'))) throw new Error('Installer payload must contain the packaged Harness Studio executable and app.asar');
  const target = relative => `$INSTDIR\\${relative.split(path.sep).join('\\')}`;
  return ['!macro HarnessRemovePayload', ...folders.map(folder => `  Push "${target(folder)}"\n  Call un.HarnessCheckReparse`), ...files.sort().map(file => `  Delete "${target(file)}"`), ...folders.sort((first, second) => second.split(path.sep).length - first.split(path.sep).length).map(folder => `  RMDir "${target(folder)}"`), '!macroend', ''].join('\n');
}
