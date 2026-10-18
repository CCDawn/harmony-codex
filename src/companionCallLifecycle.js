import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function valid(record) {
  return record?.version === 1 && /^rtc_[A-Za-z0-9_-]+$/.test(record.callId || '')
    && typeof record.profileId === 'string' && record.profileId.length > 0
    && typeof record.roomId === 'string' && record.roomId.length > 0
    && Number.isSafeInteger(record.ownerPid) && record.ownerPid > 0;
}

// Local ownership receipts only: no SDP, credentials or transcript text.
export class CompanionCallJournal {
  constructor(directory) { this.directory = directory; }
  filename(callId) {
    return path.join(this.directory, createHash('sha256').update(callId).digest('hex') + '.json');
  }
  put(record) {
    if (!valid(record)) throw new Error('Invalid owned call receipt');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.filename(record.callId), temporary = file + `.${process.pid}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  list() {
    let names;
    try { names = fs.readdirSync(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const record = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
      if (!valid(record) || path.basename(this.filename(record.callId)) !== name) {
        throw new Error('Invalid owned call receipt');
      }
      return record;
    });
  }
  remove(callId) { fs.rmSync(this.filename(callId), { force: true }); }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export class CompanionCallLifecycle {
  constructor(client, journal, { pid = process.pid, isAlive = processAlive } = {}) {
    this.client = client;
    this.journal = journal;
    this.pid = pid;
    this.isAlive = isAlive;
    this.receipt = null;
  }
  async recover(profile) {
    const receipts = this.journal.list().filter(receipt =>
      receipt.profileId === profile.id && receipt.roomId === profile.roomId);
    for (const receipt of receipts) {
      // A still-running helper may own an active call. Never stop it or start
      // a competing call, even if another cleanup request was already sent.
      if (receipt.ownerPid !== this.pid && this.isAlive(receipt.ownerPid)) {
        throw new Error('Another voice helper still owns a call');
      }
    }
    for (const receipt of receipts) {
      // Failed orphan cleanup is retained for diagnosis, not retried on every
      // user call. It must never become ownership of the newly requested call.
      if (receipt.cleanupDeferredAt) continue;
      this.client.callId = receipt.callId;
      try {
        try { await this.client.stop(); }
        catch {
          this.journal.put({ ...receipt, cleanupDeferredAt: new Date().toISOString() });
          continue;
        }
        this.journal.remove(receipt.callId);
      } finally {
        this.client.callId = null;
      }
    }
  }
  async start(params) {
    if (this.client.callId) throw new Error('A personal assistant call is already allocated');
    const profile = this.client.profile?.id && this.client.profile?.roomId
      ? this.client.profile
      : await this.client.discover();
    await this.recover(profile);
    const result = await this.client.start(params);
    this.receipt = { version: 1, profileId: profile.id, roomId: profile.roomId,
      callId: result.callId, ownerPid: this.pid, createdAt: new Date().toISOString() };
    try { this.journal.put(this.receipt); }
    catch (error) {
      // Never expose an untracked call as ready. The client keeps ownership
      // if compensating stop fails, so helper shutdown can try once more.
      try { await this.client.stop(); } catch {}
      throw error;
    }
    return result;
  }
  async stop() {
    if (!this.client.callId) return { ok: true };
    const callId = this.client.callId;
    const result = await this.client.stop();
    this.journal.remove(callId);
    this.receipt = null;
    return result;
  }
}
