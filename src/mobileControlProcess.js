import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const failure = () => new Error('Mobile control process did not complete');

// File-backed stdio deliberately has no Node pipe to wait on. A controller can
// exit while its independently managed services retain inherited output handles.
export async function runMobileControlProcess(executable, args, options = {}) {
  let directory;
  let stdout;
  let stderr;
  let child;
  try {
    const timeout = options.timeout ?? 240000;
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isSafeInteger(maxBuffer) || maxBuffer < 0
      || (encoding !== null && encoding !== 'buffer' && !Buffer.isEncoding(encoding))) throw failure();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mobile-control-'));
    stdout = await fs.open(path.join(directory, 'stdout'), 'wx+', 0o600);
    stderr = await fs.open(path.join(directory, 'stderr'), 'wx+', 0o600);
    child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true,
      stdio: ['ignore', stdout.fd, stderr.fd] });
    await new Promise((resolve, reject) => {
      let done = false;
      let failed = false;
      let checking = false;
      let killDeadline;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(deadline); clearTimeout(killDeadline); clearInterval(sizeWatch);
        if (ok) resolve(); else reject(failure());
      };
      const stop = () => {
        if (done || failed) return;
        failed = true;
        // Only the directly spawned controller is ours. Its background service
        // descendants retain their own lifecycle and must never be tree-killed.
        try { child.kill('SIGKILL'); } catch {}
        killDeadline = setTimeout(() => finish(false), 5000);
        killDeadline.unref();
      };
      const deadline = setTimeout(stop, timeout);
      const sizeWatch = setInterval(async () => {
        if (done || checking) return;
        checking = true;
        try {
          const sizes = await Promise.all([stdout.stat(), stderr.stat()]);
          if (sizes.some((stat) => stat.size > maxBuffer)) stop();
        } catch { if (!done) stop(); }
        finally { checking = false; }
      }, 50);
      sizeWatch.unref();
      child.once('error', () => finish(false));
      // Do not use close: inherited streams may belong to long-lived services.
      child.once('exit', (code, signal) => finish(!failed && code === 0 && signal === null));
    });
    async function readBounded(handle) {
      const buffer = Buffer.alloc(maxBuffer + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maxBuffer) throw failure();
      const value = buffer.subarray(0, length);
      return encoding === null || encoding === 'buffer' ? value : value.toString(encoding);
    }
    const [out, err] = await Promise.all([readBounded(stdout), readBounded(stderr)]);
    return { stdout: out, stderr: err };
  } catch {
    throw failure();
  } finally {
    // Close our descriptors first, then remove only the two known files and
    // their one private directory. Never recurse or delete by a derived glob.
    const closed = await Promise.allSettled([stdout?.close(), stderr?.close()]);
    let cleanupFailed = closed.some((result) => result.status === 'rejected');
    if (directory) {
      const removed = await Promise.allSettled(['stdout', 'stderr'].map(async (name) => {
        try { await fs.unlink(path.join(directory, name)); }
        catch (error) { if (error.code !== 'ENOENT') throw failure(); }
      }));
      cleanupFailed ||= removed.some((result) => result.status === 'rejected');
      try { await fs.rmdir(directory); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw failure();
  }
}
