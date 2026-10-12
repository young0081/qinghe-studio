import { lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { mkdir, lstat, realpath, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { atomicJson } from './settings.js';

const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const empty = () => ({ version: 1, providerCatalog: { version: 1, providers: [], active: null, legacyProviderId: null }, runLeases: [] });

export function resolveGlobalConfigDir(value) {
  const directory = value ?? (process.env.HARNESS_CONFIG_DIR || (process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Harness', 'shared') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'harness')));
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw failure('全局配置目录无效');
  return path.resolve(directory);
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export class GlobalProviders {
  constructor(directory) {
    this.directory = resolveGlobalConfigDir(directory);
    this.filename = path.join(this.directory, 'providers.json');
    this.lockfile = path.join(this.directory, 'providers.lock');
  }

  read() {
    try {
      if (lstatSync(this.directory).isSymbolicLink()) throw failure('全局配置目录不能是符号链接');
      const information = lstatSync(this.filename);
      if (information.isSymbolicLink() || !information.isFile() || information.size > 16 * 1024 * 1024) throw failure('全局供应商配置不是安全的普通文件');
      const value = JSON.parse(readFileSync(this.filename, 'utf8'));
      if (!value || value.version !== 1 || !value.providerCatalog || !Array.isArray(value.runLeases) || value.runLeases.some(lease => !lease || typeof lease.id !== 'string' || typeof lease.owner !== 'string' || !Number.isInteger(lease.pid) || typeof lease.providerId !== 'string' || typeof lease.modelId !== 'string')) throw failure('全局供应商配置格式无效');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      if (error instanceof SyntaxError) throw failure('全局供应商配置 JSON 无效');
      throw error;
    }
  }

  async reclaim(information, owner) {
    const identity = owner?.token || `${information.dev}:${information.ino}:${information.mtimeMs}:${information.size}`;
    const filename = `${this.lockfile}.${createHash('sha256').update(identity).digest('hex')}.reclaim`;
    let handle;
    try { handle = await open(filename, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    try {
      const latest = lstatSync(this.lockfile);
      if (latest.isSymbolicLink() || !latest.isFile() || latest.mtimeMs !== information.mtimeMs || latest.size !== information.size) return;
      if (owner?.token) {
        let current;
        try { current = JSON.parse(readFileSync(this.lockfile, 'utf8')); } catch { return; }
        if (current.token !== owner.token || processAlive(current.pid)) return;
      }
      unlinkSync(this.lockfile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle.close(); await rm(filename, { force: true }); }
  }

  async transaction(change, afterCommit) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw failure('全局配置目录不能是符号链接');
    const canonical = await realpath(this.directory);
    const token = randomUUID();
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        const handle = await open(this.lockfile, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
        finally { await handle.close(); }
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const information = await lstat(this.lockfile).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null; });
        if (!information) continue;
        if (information.isSymbolicLink() || !information.isFile()) throw failure('全局供应商锁文件无效');
        let owner;
        try { owner = JSON.parse(readFileSync(this.lockfile, 'utf8')); } catch {}
        if (typeof owner?.token === 'string' && !processAlive(owner.pid) || !owner && Date.now() - information.mtimeMs > 30000) await this.reclaim(information, owner);
        if (Date.now() >= deadline) throw failure('全局供应商配置正在由其他进程更新，请稍后重试', 409);
        await pause(20);
      }
    }
    try {
      if (realpathSync(this.directory) !== canonical) throw failure('全局配置目录已变更');
      const previous = this.read();
      const record = structuredClone(previous);
      record.runLeases = record.runLeases.filter(lease => processAlive(lease.pid));
      const result = await change(record);
      if (realpathSync(this.directory) !== canonical) throw failure('全局配置目录已变更');
      await atomicJson(this.filename, record);
      try { await afterCommit?.({ record, result }); }
      catch (error) {
        try { await atomicJson(this.filename, previous); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], '无法回滚全局供应商更新，请检查配置目录权限和磁盘空间'); }
        throw error;
      }
      return { record, result };
    } finally {
      let owner;
      try { owner = JSON.parse(readFileSync(this.lockfile, 'utf8')); } catch {}
      if (owner?.token === token) await rm(this.lockfile, { force: true });
    }
  }
}
