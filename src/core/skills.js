import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { atomicJson, atomicText } from './settings.js';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
export function skillName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(name) || reserved.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) fail('技能名称须为 1–80 个字母、数字、下划线或连字符，不能是系统保留名称');
  return name;
}

export function skillPath(value) {
  if (typeof value !== 'string' || value.length > 240 || value.split('/').some(part => !part || part === '.' || part === '..' || /[\\:<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || reserved.test(part))) fail('技能文件路径无效');
  return value;
}

export function skillMetadata(content) {
  const text = content.replace(/^\uFEFF/, '');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const field = key => {
    const value = front.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() || '';
    if (/^[>|][-+]?$/.test(value)) return (front.match(new RegExp(`^${key}:.*\\r?\\n((?:[ \\t]+[^\\n]*\\n?)+)`, 'm'))?.[1] || '').trim().replace(/\s+/g, ' ');
    return value.replace(/^(['"])(.*)\1$/, '$2');
  };
  return { title: field('name').slice(0, 160), description: field('description').slice(0, 800) || text.replace(/^---[\s\S]*?\n---\s*/, '').split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'))?.slice(0, 800) || '' };
}

function unzip(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./skill-zip-worker.js', import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('技能 ZIP 解压超时')); }, 5000);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); result.error ? reject(Object.assign(new Error(result.error), { statusCode: 400 })) : resolve(result.files); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('技能 ZIP 无法解压')); });
  });
}

export class Skills {
  constructor(harness) { this.harness = harness; this.root = path.join(harness.dataDir, 'skills'); this.queue = Promise.resolve(); }

  mutate(operation) {
    const pending = this.queue.catch(() => {}).then(async () => {
      if (this.harness.closed) fail('工作区已关闭', 409);
      const result = await operation();
      this.harness.extensionsChanged();
      return result;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  async safe(relative = '') {
    let target = this.harness.dataDir;
    for (const part of ['skills', ...relative.split('/').filter(Boolean)]) {
      target = path.join(target, part);
      try { if ((await lstat(target)).isSymbolicLink()) fail('技能文件不能是符号链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return target;
  }

  async state() {
    try {
      const value = JSON.parse(await this.harness.internalText('skills-state.json', 65536));
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('技能状态文件损坏');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  async list() {
    const state = await this.state();
    let entries;
    try { entries = await readdir(await this.safe(), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const results = [];
    for (const entry of entries.filter(item => !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 128)) {
      try {
        skillName(entry.name);
        const { content } = await this.get(entry.name, false);
        results.push({ name: entry.name, ...skillMetadata(content), enabled: state[entry.name] !== false });
      } catch { results.push({ name: entry.name, enabled: false, error: '无法读取 SKILL.md，请检查名称、文件大小及符号链接' }); }
    }
    return results;
  }

  async get(name, files = true, enabledOnly = false) {
    skillName(name);
    if (enabledOnly && (await this.state())[name] === false) fail('该技能已停用', 409);
    const content = await this.harness.internalText(`skills/${name}/SKILL.md`, 65536);
    return { name, content, ...(files ? { files: await this.files(name), basePath: path.join(this.root, name) } : {}) };
  }

  async files(name) {
    const result = [];
    let entries = 0;
    const visit = async (relative, depth) => {
      if (depth > 12) fail('技能目录层级超过 12 层');
      for (const entry of await readdir(await this.safe(`${skillName(name)}${relative ? '/' + relative : ''}`), { withFileTypes: true })) {
        if (++entries > 512) fail('技能目录条目过多');
        const file = skillPath(relative ? `${relative}/${entry.name}` : entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(file, depth + 1);
        else if (entry.isFile()) result.push({ path: file, size: (await lstat(await this.safe(`${name}/${file}`))).size });
        if (result.length > 256) fail('技能文件超过 256 个');
      }
    };
    await visit('', 0);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(name, relative, offset = 0, limit = 12000) {
    await this.get(name, false, true);
    skillPath(relative);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 24000) fail('读取范围无效');
    const target = await this.safe(`${name}/${relative}`);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) fail('只能读取不超过 2 MiB 的技能文本文件');
    const bytes = await readFile(target);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (content.includes('\0')) throw new Error(); }
    catch { fail('该文件不是 UTF-8 文本；可在技能目录中查看原文件'); }
    return { name, path: relative, content: content.slice(offset, offset + limit), offset, total: content.length, truncated: offset + limit < content.length };
  }

  import(input) {
    return this.mutate(async () => {
      let files = input.files;
      if (input.zip !== undefined) {
        if (typeof input.zip !== 'string' || input.zip.length > 12 * 1024 * 1024) fail('技能 ZIP 不能超过 8 MiB');
        files = await unzip(Buffer.from(input.zip, 'base64'));
      } else if (input.content !== undefined) files = [{ path: 'SKILL.md', data: Buffer.from(String(input.content)).toString('base64') }];
      if (!Array.isArray(files) || !files.length || files.length > 256) fail('请导入 SKILL.md 或包含它的技能目录（最多 256 个文件）');
      const instructions = files.filter(file => /(^|\/)SKILL\.md$/.test(file?.path));
      if (instructions.length !== 1) fail('每次导入的技能包必须恰好包含一个 SKILL.md');
      const prefix = instructions[0].path.slice(0, -8);
      let total = 0;
      const seen = new Set();
      const decoded = files.map(file => {
        skillPath(file.path);
        if (!file.path.startsWith(prefix)) fail('技能包包含根目录之外的文件');
        const relative = skillPath(file.path.slice(prefix.length));
        if (relative.split('/').length > 12 || seen.has(relative.toLowerCase())) fail('技能包存在重复文件或层级过深');
        seen.add(relative.toLowerCase());
        if (typeof file.data !== 'string' || file.data.length > 3 * 1024 * 1024) fail('技能单文件不能超过 2 MiB');
        const bytes = Buffer.from(file.data, 'base64');
        total += bytes.length;
        if (bytes.length > 2 * 1024 * 1024 || total > 8 * 1024 * 1024) fail('技能文件总量不能超过 8 MiB');
        return { relative, bytes };
      });
      const contentBytes = decoded.find(file => file.relative === 'SKILL.md').bytes;
      if (!contentBytes.length || contentBytes.length > 65536) fail('SKILL.md 必须为 1–65536 字节');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes); } catch { fail('SKILL.md 必须是 UTF-8 文本'); }
      const name = skillName(input.name || skillMetadata(content).title || prefix.split('/').filter(Boolean).at(-1));
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('enabled 必须为布尔值');
      const state = await this.state();
      if ((await this.list()).length >= 128) fail('当前工作区最多安装 128 个技能');
      const target = await this.safe(name);
      try { await lstat(target); fail('同名技能已存在，请编辑原技能或换一个名称', 409); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(this.root, { recursive: true });
      const stage = path.join(this.root, `.import-${randomUUID()}`);
      await mkdir(stage);
      try {
        for (const file of decoded) {
          const destination = path.join(stage, file.relative);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
        }
        state[name] = input.enabled === true;
        await atomicJson(path.join(this.harness.dataDir, 'skills-state.json'), state);
        await rename(stage, target);
      } finally { await rm(stage, { recursive: true, force: true }); }
      return this.get(name);
    });
  }

  update(name, patch) {
    return this.mutate(async () => {
      await this.get(name, false);
      if (patch.content !== undefined && (typeof patch.content !== 'string' || !patch.content.trim() || Buffer.byteLength(patch.content) > 65536)) fail('SKILL.md 必须是非空文本且不超过 64 KiB');
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') fail('enabled 必须为布尔值');
      if (patch.content !== undefined) await atomicText(await this.safe(`${name}/SKILL.md`), patch.content);
      if (patch.enabled !== undefined) { const state = await this.state(); state[name] = patch.enabled; await atomicJson(path.join(this.harness.dataDir, 'skills-state.json'), state); }
      return this.get(name);
    });
  }

  remove(name) {
    return this.mutate(async () => {
      skillName(name);
      const target = await this.safe(name);
      if (path.dirname(target) !== this.root) fail('技能目录越界');
      await rm(target, { recursive: true, force: true });
      const state = await this.state();
      delete state[name];
      await atomicJson(path.join(this.harness.dataDir, 'skills-state.json'), state);
      return { removed: true };
    });
  }
}
