import { zipSync, strToU8 } from 'fflate';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
export const documentText = '附件中的项目说明：这是用户导入的资料。';
export const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document><w:body><w:p><w:r><w:t>${documentText}</w:t></w:r></w:p></w:body></w:document>`) }));
export const xlsx = Buffer.from(zipSync({ 'xl/sharedStrings.xml': strToU8('<sst><si><t>项目预算</t></si></sst>'), 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1200</v></c></row></sheetData></worksheet>') }));
export const pptx = Buffer.from(zipSync({ 'ppt/slides/slide1.xml': strToU8('<p:sld><a:p><a:r><a:t>演示文档标题</a:t></a:r></a:p></p:sld>') }));

const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 100 Td (Harness file) Tj ET\nendstream'];
let pdfText = '%PDF-1.4\n';
const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdfText)); pdfText += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdfText);
pdfText += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
export const pdf = Buffer.from(pdfText);

export const wav = Buffer.alloc(16044);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);

export const upload = (name, bytes) => ({ name, data: bytes.toString('base64') });

export async function pasteFiles(page, files, selector = '#prompt') {
  await page.locator(selector).evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([Uint8Array.from(atob(entry.data), character => character.charCodeAt(0))], entry.name, { type: entry.mimeType || 'application/octet-stream' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, files);
}

export async function dropFiles(page, files) {
  await page.locator('form.composer').evaluate((element, entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([Uint8Array.from(atob(entry.data), character => character.charCodeAt(0))], entry.name));
    for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files);
}
