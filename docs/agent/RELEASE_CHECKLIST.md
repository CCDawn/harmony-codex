# Agent Open Source Release Checklist

Run this before pushing to GitHub.

## Required

- [ ] `scripts\agent\scan-open-source.ps1` reports no high-risk findings in publishable files.
- [ ] `.gitignore` excludes logs, HAPs, signing files, tmp files, local configs, binaries, SDK overlays, and extracted desktop bundles.
- [ ] `README.md` contains no real IP, token, or device ID.
- [ ] `AGENTS.md` explains the agent deployment flow.
- [ ] `docs\agent\BOOTSTRAP.md` has complete setup commands.
- [ ] `docs\agent\TROUBLESHOOTING.md` has failure branches for bridge, sessions, CDP, HDC, and relay.
- [ ] `HarmonyCodexRemote\entry\src\main\ets\config\BridgeConfig.ets` is not staged.
- [ ] `tools\harmony\*.local.psd1` are not staged.
- [ ] `tmp\`, `logs\`, `artifacts\`, and `bin\` are not staged.
- [ ] A final license has been selected and added.
- [ ] If a previous public push contained signing material or tokens, rotate those credentials before publishing again.

## Clean Staging Directory

Do not publish the live working directory directly. Run the full release verifier:

```powershell
npm run agent:verify-release
```

This creates a clean staging directory, scans it, checks forbidden file classes, and runs the test suite in the staging directory.

Manual equivalent:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\create-open-source-staging.ps1 -ForceClean
cd "$HOME\Desktop\harmony-codex-open-source"
powershell -ExecutionPolicy Bypass -File .\scripts\agent\scan-open-source.ps1
npm test
```

## Suggested GitHub Flow

Create a private repository first:

```powershell
git init
git add .
git status --short
git commit -m "chore: prepare agent-first open source release"
gh repo create <owner>/harmony-codex --private --source . --remote origin --push
```

After GitHub-side scanning and one more local review, switch to public:

```powershell
gh repo edit <owner>/harmony-codex --visibility public
```
