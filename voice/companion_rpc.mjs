import readline from 'node:readline';
import { CompanionDesktopClient } from '../src/companionDesktopClient.js';

const client = new CompanionDesktopClient();
const input = readline.createInterface({ input: process.stdin, terminal: false });
const methods = new Set(['discover', 'history', 'start', 'attach', 'stop']);
try {
  for await (const line of input) {
    let request;
    try {
      request = JSON.parse(line);
      if (!methods.has(request.method)) throw new Error('Unsupported Companion operation');
      const result = await client[request.method](request.params ?? {});
      process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    } catch (error) {
      // Never include raw HTTP bodies, SDP, credentials, or private messages in errors.
      const message = error?.status ? `Companion HTTP ${error.status}` : 'Companion request failed';
      process.stdout.write(JSON.stringify({ id: request?.id, error: message }) + '\n');
    }
  }
} finally {
  try { await client.stop(); } catch {}
  client.close();
}
