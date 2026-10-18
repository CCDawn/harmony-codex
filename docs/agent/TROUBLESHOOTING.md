# Agent Troubleshooting Guide

Always start with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\agent\doctor.ps1 -Json
```

## Bridge Offline

Symptoms:

- `bridge` is `fail`.
- Phone shows connection failure.

Actions:

1. Start stack: `scripts\agent\start-stack.ps1`.
2. Check `logs\startup`.
3. Re-run doctor.

## Sessions Empty

Symptoms:

- `sessions` is `fail`.
- Phone shows no conversations.

Actions:

1. Confirm bridge is `ok`.
2. Confirm Codex session files exist under the user's Codex home.
3. Check `/codex/sessions` through the bridge.
4. Do not assume the phone app is broken until the bridge API is verified.

Personal-assistant history reads verify the selected profile and room first.
Room members and message pages are then fetched concurrently; messages are
returned only after member validation provides the author roles. A failed member
read fails the request rather than presenting messages with guessed roles.
This reduces one sequential network wait without caching conversation data or
retaining a shared desktop client across requests.

## CDP Offline

Symptoms:

- `cdp` is `warn` or `fail`.
- Desktop live sending fails.
- Phone recovery says no CDP endpoint is available.

Actions:

1. Do not claim live desktop sending is verified.
2. Try soft recovery first if the bridge is online.
3. If Codex Desktop was launched without CDP, the user must explicitly start the CDP-capable desktop path.
4. Do not silently restart Codex Desktop.

The doctor's top-level `ok` requires Node, the package, bridge, and sessions
checks to pass. Optional CDP/HDC/relay warnings still need separate inspection.
A successful HTTP response from `/desktop/live/status` is only marked ready
when its body explicitly reports `desktop.desktopLive=true`.

## Voice Cold Start And Recovery

The `/voice` proxy allows up to six seconds for managed-process startup and
upstream TCP connection, below the phone's eight-second WebSocket timeout.
Each TCP attempt has a 750 ms timeout. Cancelling the phone connection cancels
pending upstream work. `voice.tunnel.opened` records `startupMs` and `attempts`;
it proves TCP connectivity, not assistant media readiness or audible speech.

Repeated early voice-process exits increase the restart delay up to 30 seconds.
The crash streak resets after a process remains alive for 30 seconds. Closing
the supervisor cancels both restart and stability timers. An SSH task running,
a voice process running, or a successful WebSocket upgrade still needs media
and microphone/playback verification before claiming a working phone call.

## HDC Offline

Symptoms:

- `hdc` is `fail`.
- App cannot deploy or screenshots cannot be captured.

Actions:

1. Check `HdcPath` in local config.
2. Run `hdc list targets`.
3. Unlock the phone.
4. If remote HDC is used, check relay config and helper app state.

## Relay Waiting For PC

Symptoms:

- Phone helper says it is waiting for computer.
- `relay` is not `ok`.

Actions:

1. Confirm the Windows local proxy is running.
2. Confirm `RelayHost`, `RelayPort`, `DeviceId`, and `Token` match on both sides.
3. Check firewall and VPS security group.
4. Re-run doctor and relay-specific scripts.

## Message Send Timeout

Symptoms:

- Phone shows send failed or timeout.
- Desktop may not show the message.

Actions:

1. Inspect `/system/link/status` for current session.
2. Confirm the target session id still exists.
3. Confirm desktop live/CDP status.
4. If failed message exists in the phone UI, use retry after link recovery.
5. Do not create a new thread unless the user explicitly asks.

## Desktop-owned App Server Runtime

The default runtime is `desktop`. The phone may operate thread B while the
desktop displays thread A. A difference between those selected thread ids is
informational and must not block sending, provided the desktop-owned App Server
can verify B. A desktop channel outage remains blocking because the Bridge must
not silently start a second owner.

Inspect the effective contract with:

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/health?threadId=<thread-id>"
Invoke-RestMethod "http://127.0.0.1:8787/system/link/status?sessionId=<thread-id>"
```

Expected fields are `runtime.mode=desktop`,
`runtime.existingThreadExecution=desktop`,
`link.executionMode=desktop`, and `link.desktopRequired=true`. If the desktop
currently displays another thread, `desktop.sessionVerified=false` together
with `desktop.targetVerified=true` and `desktop.status=target_ready` is healthy.

## Desktop Target Verification Failure

If the phone reports the desktop channel offline or the target cannot be
verified, inspect:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
Invoke-RestMethod "http://127.0.0.1:8787/desktop/live/status?sessionId=<thread-id>"
```

Do not switch to `app-server-primary` as an automatic fallback. That would
create a second live owner and can make the phone and desktop event streams
diverge.

## App Server Primary Failure

If the stack reports an App Server runtime failure, inspect the bridge startup
logs first and keep the phone connected through the normal bridge/HDC route:

```powershell
Get-Content .\logs\startup\bridge.stderr.log -Tail 120
Invoke-RestMethod http://127.0.0.1:8787/health
```

The explicit compatibility mode contains
`runtime.mode=app-server-primary` and a `runtime.appServer` object. This mode
does not guarantee that the desktop frontend renders the same live event
stream. Do not expose the App Server stdio process or any local App Server port
directly to the phone or the public relay.

Return to the desktop-owned mode with:

```powershell
npm.cmd run agent:start -- -RuntimeMode desktop -ForceRestart
```
