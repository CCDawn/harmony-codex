import { runLiveAppServerTurnProbe } from '../src/liveAppServerTurnProbe.js';

if (!process.argv.includes('--confirm-live')) {
  process.stderr.write(
    'Live probe not started. Pass --confirm-live to create two controlled Codex turns.\n'
  );
  process.exitCode = 2;
} else {
  const report = await runLiveAppServerTurnProbe({
    cwd: process.cwd()
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}


