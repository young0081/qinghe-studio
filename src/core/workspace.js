import path from 'node:path';
import { lstat, realpath, readdir, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 1024 * 1024;

export class Workspace {
  constructor(root, dataDir) {
    this.root = root;
    this.dataDir = dataDir;
  }

  inside(base, candidate) {
    const relative = path.relative(base, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }

  async resolve(relative = '.', { allowMissing = false } = {}) {
    if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes(':')) throw new Error('路径必须是工作区内的相对路径');
    const absolute = path.resolve(this.root, relative);
    if (!this.inside(this.root, absolute)) throw new Error('路径超出工作区');
    if (this.inside(this.dataDir, absolute)) throw new Error('禁止访问 青禾 Studio 内部数据目录');
    const parts = path.relative(this.root, absolute).split(path.sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      if (process.platform === 'win32' && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('不安全的 Windows 路径');
      current = path.join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if (error.code === 'ENOENT' && allowMissing) return absolute;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('安全限制：不跟随符号链接');
      const resolved = await realpath(current);
      if (!this.inside(this.root, resolved) || this.inside(this.dataDir, resolved)) throw new Error('路径超出工作区或指向内部数据目录');
    }
    return absolute;
  }

  relative(absolute) { return path.relative(this.root, absolute).split(path.sep).join('/') || '.'; }

  async list(relative = '.') {
    const absolute = await this.resolve(relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    const output = [];
    for (const entry of entries.sort((first, second) => Number(second.isDirectory()) - Number(first.isDirectory()) || first.name.localeCompare(second.name))) {
      const target = path.join(absolute, entry.name);
      if (this.inside(this.dataDir, target)) continue;
      const stat = await lstat(target);
      output.push({ name: entry.name, path: this.relative(target), type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file', size: stat.size });
    }
    return output.slice(0, 2000);
  }

  async read(relative) {
    const absolute = await this.resolve(relative);
    const stat = await lstat(absolute);
    if (!stat.isFile()) throw new Error('目标不是普通文件');
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 1 MiB 读取限制');
    const buffer = await readFile(absolute);
    if (buffer.includes(0)) throw new Error('不支持读取二进制文件');
    return { path: this.relative(absolute), content: buffer.toString('utf8') };
  }

  async write(relative, content) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('写入内容必须是不超过 1 MiB 的文本');
    const absolute = await this.resolve(relative, { allowMissing: true });
    if (absolute === this.root) throw new Error('不能覆盖工作区目录');
    let existing;
    try { existing = await lstat(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !existing.isFile()) throw new Error('只能写入普通文件');
    await mkdir(path.dirname(absolute), { recursive: true });
    await this.resolve(relative, { allowMissing: true });
    const temporary = path.join(path.dirname(absolute), `.harness-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: existing ? existing.mode & 0o777 : 0o666 });
      await this.resolve(relative, { allowMissing: true });
      await rename(temporary, absolute);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    return this.relative(absolute);
  }

  async remove(relative) {
    const absolute = await this.resolve(relative);
    const stat = await lstat(absolute);
    if (!stat.isFile()) throw new Error('只能删除普通文件');
    await rm(absolute);
  }

  async search({ query, path: relative = '.', maxResults = 100 }) {
    if (typeof query !== 'string' || query.length === 0) throw new Error('query 不能为空');
    const limit = Math.min(500, Math.max(1, Number(maxResults) || 100));
    const results = [];
    let visited = 0;
    const visit = async directory => {
      for (const entry of await this.list(directory)) {
        if (++visited > 10000 || results.length >= limit) return;
        if (entry.type === 'directory') {
          if (!['node_modules', '.git', 'dist', '.harness'].includes(entry.name)) await visit(entry.path);
        } else if (entry.type === 'file' && entry.size <= MAX_FILE_BYTES) {
          let file;
          try { file = await this.read(entry.path); } catch { continue; }
          for (const [index, line] of file.content.split(/\r?\n/).entries()) {
            if (line.includes(query)) results.push({ path: entry.path, line: index + 1, text: line.slice(0, 1000) });
            if (results.length >= limit) return;
          }
        }
      }
    };
    const absolute = await this.resolve(relative);
    if ((await lstat(absolute)).isFile()) {
      const file = await this.read(relative);
      for (const [index, line] of file.content.split(/\r?\n/).entries()) {
        if (line.includes(query)) results.push({ path: file.path, line: index + 1, text: line.slice(0, 1000) });
        if (results.length >= limit) break;
      }
    } else await visit(relative);
    return { matches: results, truncated: results.length >= limit || visited > 10000 };
  }
}
