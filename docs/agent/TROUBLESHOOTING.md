# Agent Troubleshooting Guide

## Desktop Startup Window and Recovery Progress

The desktop shortcut opens a modeless connection window before checking or
starting services. Closing this window hides it in the tray and does not stop
the link. A persisted manual Stop remains stopped until Start is requested.

Start and Repair publish fixed, credential-free stages in
`logs/state/mobile-link-operation.json`. The operation has an identity and a
deadline; repeated requests join the active operation. Repair results are kept
under `logs/state/desktop-repair-results/`, with the latest result also available
at the existing `desktop-repair-result.json` path. An operation completion alone
does not prove readiness: the window reads current connection and conversation
checks before displaying success.

The automatic guardian and its restart permission are separate settings.
Enable/Disable preserve the saved permission. The window displays the actual
permission and provides an explicit control for allowing automatic Codex restart.
Each faulty component retains its own recovery attempts and cooldown, so a
flapping voice tunnel cannot reset a persistent desktop failure.

The normal status view checks the public conversation endpoint, recent phone
heartbeat, and local memory resources as well as the desktop. A phone heartbeat
is not proof of message delivery or audible voice. The optional HDC installation
channel is shown in details and is not a requirement for ordinary conversation.
Memory pressure is reported separately and never authorizes terminating unrelated
applications or restarting a healthy desktop.

Detached bootstrap processes carry the control-state generation and, for guardian
repairs, the guardian-configuration generation. Stop, Disable, and a later
Stop/Start or Disable/Enable invalidate the earlier request. Cancellation is
checked again before process/task mutations and exits with code 12. Stop publishes
its intent before waiting for the lifecycle gate and waits for bounded in-flight
launchers before cleaning up managed services. A third-round guardian desktop
repair retains its selected components and bypasses whole-stack/HDC bootstrap.
Every Start/Repair requires personal-assistant readback as well as the bridge,
desktop connection and ordinary sessions before reporting readiness.

On the phone, completed tasks with more event pages continue reading until the
last page, then perform terminal cleanup once. Stalled cursors retry at a bounded
cadence. If a runtime snapshot becomes stale, fresh session-list data takes
precedence; stale metadata cannot claim a task is active or interruptible.

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

Guardian distinguishes the local media service from the SSH voice tunnel.
A scheduled task in `Ready` can coexist with a live supervisor from an earlier
launch; check the precisely bound process, SSH connection, and forwarding log
before declaring an outage. An authenticated public voice upgrade takes
precedence over an inactive launcher snapshot. Do not restart media solely
because the tunnel task is not running.

Before a queued voice recovery stops anything, it repeats connection-only
probes. A recovered route cancels the stop; missing, malformed, authentication,
or incompatible diagnostics do not authorize it. A confirmed local media fault
restarts only media, and a confirmed tunnel fault repairs only the tunnel.
Neither probe starts a conversation or uploads microphone audio.

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

History reads subscribe to the running desktop app's assembled host-message
receiver. Recent desktop builds send large replies as chunk envelopes; raw
`window` message listeners do not receive a complete `mcp-response` for those
replies. Reuse the app's receiver so it remains the sole owner of reassembly and
acknowledgements. Discover the receiver from the active module graph rather than
pinning a hashed asset or export from an installed build. If it is unavailable,
report a compatibility error before dispatching the request.

Large assembled replies use bounded CDP return chunks rather than one large
WebSocket frame. This also supports older installed Node 24 runtimes that can
read small CDP results but disconnect on multi-megabyte results. Transfer buffers
are isolated per response, released after collection (including failed reads),
and expire after 60 seconds if the bridge disappears. At most 16 transfers may
be retained; partial or mismatched chunks are never returned as valid history.

A timed-out CDP evaluation rejects only that call. Do not close the shared socket
or reject other pending reads merely because one evaluation is slow. Actual
socket errors and closures still invalidate the connection and all pending calls.

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

## SSH Forward Remains Bound After a Connection Reset

The managed voice/public reverse tunnel runs `voice_tunnel_watchdog.py` inside
its own SSH connection. The relay needs Linux Python 3 with `pidfd_open` and
`pidfd_send_signal`. The runner disables SSH connection multiplexing and uses
the configured identity explicitly. No watchdog file is installed on the relay.

The watchdog checks `OPTIONS /health` through its loopback forward. This tests
HTTP transport without spending the bridge's authentication failure budget;
it does not prove authentication, desktop availability or successful dialogue.
After three consecutive failed probes, it verifies its direct SSH parent and
the exact listener ownership again, then retires only that connection. The
local supervisor can establish a replacement forward. Ownership or capability
failures are logged as `voice-watchdog state=refused`, without signaling a PID.

An older connection created before the watchdog was loaded has no watchdog.
Do not use broad `sshd` process cleanup to recover it. Inspect the exact stale
listener and transport separately; restarting a healthy Codex desktop or bridge
does not release a stale remote SSH listener.
