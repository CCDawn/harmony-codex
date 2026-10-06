import { runLiveAppServerProbe } from '../src/liveAppServerProbe.js';

const report = await runLiveAppServerProbe();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) {
  process.exitCode = 1;
}

