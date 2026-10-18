import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CompanionCallJournal, CompanionCallLifecycle } from '../src/companionCallLifecycle.js';
import { CompanionDesktopClient } from '../src/companionDesktopClient.js';
import { companionRpcErrorFields } from '../src/companionErrors.js';

const client = new CompanionDesktopClient();
const lifecycle = new CompanionCallLifecycle(client, new CompanionCallJournal(
  fileURLToPath(new URL('./voice-scratch/owned-calls/', import.meta.url))));
const input = readline.createInterface({ input: process.stdin, terminal: false });
const methods = new Set(['discover', 'history', 'start', 'attach', 'stop']);
try {
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
      if (!methods.has(request.method)) throw new Error('Unsupported Companion operation');
      const owner = request.method === 'start' || request.method === 'stop' ? lifecycle : client;
      const result = await owner[request.method](request.params ?? {});
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    } catch (error) {
      // Never include raw HTTP bodies, SDP, credentials, or private messages in errors.
      const fields = companionRpcErrorFields(error, request?.method);
      process.stdout.write(JSON.stringify({ id: request?.id, ...fields }) + '\n');
    }
  }
} finally {
  try { await lifecycle.stop(); } catch {}
  client.close();
}
