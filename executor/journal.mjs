import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensure } from './core.mjs';

/** Keep outside the public repository. One journal directory for all batches of a tenant. */
export class FileJournal {
  constructor(directory, tenant) {
    ensure(typeof tenant === 'string' && tenant.length >= 3, 'TENANT_REQUIRED', 'Empresa obrigatória.');
    this.directory = resolve(directory);
    const prefix = createHash('sha256').update(tenant).digest('hex');
    this.path = join(this.directory, prefix + '.json');
    this.lockPath = join(this.directory, prefix + '.lock');
  }
  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    ensure(!this.lock, 'BUSY', 'Executor já em uso.');
    try { this.lock = await open(this.lockPath, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') ensure(false, 'BUSY', 'Outro executor ou trava pendente. Não remover sem conferir.'); throw e; }
    try {
      await this.lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await this.lock.sync();
      try { this.records = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; this.records = {}; }
      ensure(this.records && typeof this.records === 'object' && !Array.isArray(this.records), 'CORRUPT_JOURNAL', 'Registro local inválido.');
    } catch (error) { await this.release(); throw error; }
  }
  async get(key) { ensure(this.lock, 'LOCK_REQUIRED', 'Adquira a trava.'); return structuredClone(this.records[key] ?? null); }
  async put(key, value) {
    ensure(this.lock, 'LOCK_REQUIRED', 'Adquira a trava.');
    ensure(/^[a-f0-9]{64}$/.test(key), 'INVALID_KEY', 'Chave inválida.');
    const next = { ...this.records, [key]: { ...structuredClone(value), updatedAt: new Date().toISOString() } };
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.path);
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    this.records = next;
  }
  async release() {
    if (!this.lock) return;
    await this.lock.close(); this.lock = null;
    await unlink(this.lockPath);
  }
}
