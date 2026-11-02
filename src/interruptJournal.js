import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Same serialized atomic-replace pattern as DurableOutbox.persist(). This is
// the write-ahead record for unresolved stop requests, never conversation data.
export class InterruptJournal {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.records = null;
    this.loading = null;
    this.writes = Promise.resolve();
  }

  async load() {
    await this.writes;
    return this.read();
  }

  async read() {
    if (this.records === null) {
      this.loading ??= this.readFile();
      await this.loading;
    }
    return [...this.records.values()].map(record => ({ ...record }));
  }

  async readFile() {
      let data;
      try { data = JSON.parse(await fs.readFile(this.filePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; data = { version: 1, records: [] }; }
      if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Invalid stop journal');
      this.records = new Map(data.records.map(record => { const entry = validate(record); return [entry.operationId, entry]; }));
  }

  put(record) { const entry = validate(record); return this.update(records => records.set(entry.operationId, entry)); }
  remove(operationId) { return this.update(records => records.delete(operationId)); }

  update(change) {
    const write = this.writes.then(async () => {
      await this.read();
      const next = new Map(this.records);
      change(next);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify({ version: 1, records: [...next.values()] }), { mode: 0o600 });
        await fs.rename(temporary, this.filePath);
        this.records = next;
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }
}

function validate(record) {
  if (!record || !String(record.operationId ?? '') || !String(record.threadId ?? '')
    || !['requested', 'writing', 'uncertain'].includes(record.state)
    || !Number.isFinite(Date.parse(record.requestedAt))) throw new Error('Invalid pending stop record');
  return { operationId: String(record.operationId), threadId: String(record.threadId),
    turnId: String(record.turnId ?? ''), requestedAt: record.requestedAt, state: record.state,
    hasUncertainStart: record.hasUncertainStart === true };
}
