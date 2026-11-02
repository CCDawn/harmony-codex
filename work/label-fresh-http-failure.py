from pathlib import Path
p=Path('work/probe-fresh-http-voice.py');s=p.read_text(encoding='utf-8').replace(' except urllib.error.HTTPError as e:r=e',''' except urllib.error.HTTPError as e:r=e
 except Exception as e:
  print(json.dumps({'method':method,'status':0,'networkError':type(getattr(e,'reason',e)).__name__,'durationMs':round((time.monotonic()-start)*1000)}),flush=True)
  return 0,b'' ''');p.write_text(s,encoding='utf-8')
p=Path('work/voice-route-fresh-comparison.py');s=p.read_text(encoding='utf-8').replace(' print(result.stdout,flush=True)',' print(result.stdout,flush=True)\n print(json.dumps({"probeExitCode":result.returncode}),flush=True)');p.write_text(s,encoding='utf-8')
