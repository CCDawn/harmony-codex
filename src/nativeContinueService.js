import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeContinueStatus } from './nativeContinueEligibility.js';

// One write-ahead record per operation, using the existing outbox/stop journal's
// serialized atomic replacement. No prompts, credentials or transcript bodies.
export class NativeContinueJournal {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.records = null;
    this.loading = null;
    this.writes = Promise.resolve();
  }

  async read() {
    if (this.records === null) {
      this.loading ??= (async () => {
        let data;
        try { data = JSON.parse(await fs.readFile(this.filePath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; data = { version: 1, records: [] }; }
        if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Invalid continue journal');
        this.records = new Map(data.records.map(record => { const entry = validateRecord(record); return [entry.operationId, entry]; }));
      })();
      await this.loading;
    }
    return [...this.records.values()].map(record => ({ ...record, ...(record.result ? { result: { ...record.result } } : {}) }));
  }

  async load() { await this.writes; return this.read(); }

  put(record) {
    const entry = validateRecord(record);
    const write = this.writes.then(async () => {
      await this.read();
      const next = new Map(this.records);
      next.set(entry.operationId, entry);
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

export class NativeContinueService {
  constructor({ client, journal }) {
    this.client = client;
    this.journal = journal;
    this.operations = new Map();
    this.threadQueues = new Map();
  }

  async readSnapshot(threadId) {
    validateIdentity(threadId);
    if (typeof this.client?.readContinueSnapshot !== 'function') throw statusError('Native continue is unavailable', 503);
    return readNativeState(() => this.client.readContinueSnapshot(threadId));
  }

  async getStatus(threadId) {
    const status = nativeContinueStatus(await this.readSnapshot(threadId), threadId);
    const reason = await this.blockedReason(threadId, status.turnId);
    return reason ? { ...status, canContinue: false, reason } : status;
  }

  async blockedReason(threadId, turnId) {
    const records = await this.journal.load();
    const unresolved = records.some(record => record.threadId === threadId && record.expectedTurnId === turnId
      && ['writing', 'uncertain'].includes(record.state));
    const continued = records.some(record => record.threadId === threadId && record.expectedTurnId === turnId && record.state === 'confirmed');
    const pending = [...this.operations.values()].some(operation => operation.threadId === threadId && operation.expectedTurnId === turnId);
    return unresolved ? 'uncertain_operation' : continued ? 'stale_turn' : pending ? 'operation_pending' : '';
  }

  async readContext(threadId) {
    validateIdentity(threadId);
    if (typeof this.client?.readContinueContext !== 'function') throw statusError('Native continue is unavailable', 503);
    return readNativeState(() => this.client.readContinueContext(threadId));
  }

  async continue(threadId, input = {}) {
    validateIdentity(threadId);
    const operationId = typeof input.operationId === 'string' ? input.operationId.toLowerCase() : input.operationId;
    const { expectedTurnId } = input;
    if (!uuid(operationId) || typeof expectedTurnId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(expectedTurnId)) {
      throw statusError('A UUID operationId and expectedTurnId are required', 400);
    }
    const existing = this.operations.get(operationId);
    if (existing) {
      assertSameOperation(existing, threadId, expectedTurnId);
      return existing.promise;
    }
    const previous = this.threadQueues.get(threadId) ?? Promise.resolve();
    const operation = { threadId, expectedTurnId };
    const run = previous.catch(() => {}).then(() => this.execute(threadId, operationId, expectedTurnId));
    operation.promise = run;
    this.operations.set(operationId, operation);
    this.threadQueues.set(threadId, run);
    try { return await run; }
    finally {
      if (this.operations.get(operationId) === operation) this.operations.delete(operationId);
      if (this.threadQueues.get(threadId) === run) this.threadQueues.delete(threadId);
    }
  }

  async execute(threadId, operationId, expectedTurnId) {
    const records = await this.journal.load();
    const prior = records.find(record => record.operationId === operationId);
    if (prior) {
      assertSameOperation(prior, threadId, expectedTurnId);
      return prior.result ?? resultFor({ threadId, operationId, expectedTurnId }, 'uncertain', 'write_unconfirmed');
    }
    const record = { threadId, operationId, expectedTurnId, requestedAt: new Date().toISOString(), state: 'writing' };
    const status = nativeContinueStatus(await this.readSnapshot(threadId), threadId);
    let result;
    const unresolved = records.some(value => value.threadId === threadId && value.expectedTurnId === expectedTurnId
      && ['writing', 'uncertain'].includes(value.state));
    const continued = records.find(value => value.threadId === threadId && value.expectedTurnId === expectedTurnId && value.state === 'confirmed');
    if (status.turnId !== expectedTurnId) result = resultFor(record, 'rejected', 'stale_turn', status);
    else if (continued) result = resultFor(record, 'rejected', 'stale_turn', continued.result);
    else if (unresolved) result = resultFor(record, 'rejected', 'uncertain_operation', status);
    else if (!status.canContinue) result = resultFor(record, 'rejected', status.reason, status);
    if (result) {
      await this.journal.put({ ...record, state: result.state, result });
      return result;
    }
    // Persist before entering any desktop method that can write. A process crash
    // after this point is uncertain and never becomes permission to resend.
    await this.journal.put(record);
    try {
      const observed = await this.client.continueTurn(threadId, expectedTurnId, operationId);
      result = observed?.state === 'rejected'
        ? resultFor(record, 'rejected', observed.reason, observed)
        : observed?.turnId && observed.turnId !== expectedTurnId && observed.state !== 'uncertain'
          ? resultFor(record, 'confirmed', observed.reason ?? 'started', observed)
          : resultFor(record, 'uncertain', 'write_unconfirmed', observed);
    } catch (error) {
      result = resultFor(record, error?.continueWriteAttempted === false ? 'rejected' : 'uncertain',
        error?.continueWriteAttempted === false ? 'unavailable' : 'write_unconfirmed');
    }
    try { await this.journal.put({ ...record, state: result.state, result }); }
    catch {
      // The durable writing marker remains. Do not tell a client to retry after
      // a final receipt could not be committed, even if the start was observed.
      return resultFor(record, 'uncertain', 'receipt_unpersisted', result);
    }
    return result;
  }
}

function resultFor(record, state, reason, observed = {}) {
  return { operationId: record.operationId, threadId: record.threadId, expectedTurnId: record.expectedTurnId,
    turnId: String(observed.turnId ?? record.expectedTurnId), canContinue: false, reason, state,
    active: observed.active === true || observed.state === 'active' };
}

function assertSameOperation(record, threadId, expectedTurnId) {
  if (record.threadId !== threadId || record.expectedTurnId !== expectedTurnId) throw statusError('Continue operation identity conflict', 409);
}
function validateIdentity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw statusError('Invalid thread identity', 400);
}
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validateRecord(record) {
  if (!record || !uuid(record.operationId) || !record.threadId || !record.expectedTurnId
    || !['writing', 'confirmed', 'uncertain', 'rejected'].includes(record.state)
    || !Number.isFinite(Date.parse(record.requestedAt))) throw new Error('Invalid continue record');
  return { operationId: record.operationId, threadId: record.threadId, expectedTurnId: record.expectedTurnId,
    requestedAt: record.requestedAt, state: record.state, ...(record.result ? { result: { ...record.result } } : {}) };
}
function statusError(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }

async function readNativeState(read) {
  try { return await read(); }
  catch (error) {
    // The mounted provider or CDP connection can be replaced while a thread is
    // archived/restored. Only retry this pure observation: the next invocation
    // rediscovers the current lease. Native writes never enter this helper.
    if (error?.code !== 'DESKTOP_INTERACTIONS_UNAVAILABLE'
      || !['transport', 'asset-discovery', 'mounted-manager', 'conversation-read'].includes(error.stage)) throw error;
    return read();
  }
}
