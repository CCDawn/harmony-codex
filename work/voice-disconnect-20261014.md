# Voice disconnect investigation, 2026-10-14

All incident times below are Asia/Shanghai (UTC+8). No audio, transcript,
credentials, SDP, request contents, or network addresses are included.

## Confirmed incident

- The long call became ready at 19:11:30.131.
- At 19:26:25.176, microphone input age and client activity age were both 0.1s;
  peer state was connected and microphone/track RMS remained nonzero.
- Input audio continued during the preceding 25 seconds. The microphone queue
  stayed roughly 245760–268800 bytes rather than growing without bound.
- At 19:26:25.462, peer state changed to closed and the server reported
  `WebRTC connection closed` as fatal.
- The phone-facing bridge tunnel closed at 19:26:25.776, after the media failure.
- The phone reported the dropped call at 19:26:27.120.
- This incident did not report an idle timeout, repeated-audio protection, or
  voice-process exit. Audio arrival rules out the 90-second idle trigger.

## What this establishes

The first observed terminal failure was the bridge-to-upstream WebRTC media
connection. The phone-facing tunnel closed afterward. This does not establish
that the provider intentionally ended the call: aiortc closes the peer after
DTLS transports close, which can follow remote shutdown, underlying transport
failure, or an internal transport exception. Existing logs omit that distinction.

The official call record reports 903568ms duration and a generic ended outcome.
An older call lasted 4023090ms (about 67 minutes), so a universal 15-minute cap
is not supported. Generic ended/partial metadata does not identify the trigger.

STUN retry InvalidStateError was observed at 19:23:02 and 19:24:02. Media and
microphone activity continued after these errors. They merit investigation but
cannot yet be called the cause of the later disconnect.

## Current official implementation comparison

Read-only source inspection of the running desktop's
`app-initial-b8e1c8014bb4.js` found create-call, apply-answer, attach-call and
stop-call operations. The Companion call implementation did not show an
additional periodic HTTP heartbeat. Its `keepalive` option belongs to stop-call
delivery. This is private implementation evidence, not a public API guarantee.

## Original diagnostic gap

The Companion adapter replaces upstream error event details with a generic
error. It does not log data-channel lifecycle, ICE/DTLS failure origin, or a
distinction between local teardown and remote close. The next diagnostic patch
should capture fixed event categories, allowlisted error codes, transport states
and numeric stats, without raw messages, SDP, speech or credentials. Changing
timeouts or recreating a call is not a demonstrated causal repair.

### Diagnostic update loaded at 20:05

The follow-up implements `media-state`, `media-control` and safe fixed DTLS
signals in `voice/media_diagnostics.py`, wired into existing server callbacks.
Local cleanup records its release flag before closing the peer. The DTLS filter
reads exact library log templates without formatting private arguments; newly
enabled debug output is suppressed from ordinary handlers.

Validation: diagnostics 7/7, Companion session 16/16, liveness 5/5 and startup
7/7 passed (35 total). An independent read-only review found no blocking issue.
A real local-only aiortc media pair connected successfully, then simulated a
remote shutdown; the probe observed `remote_shutdown` while the local-release
flag was false. This used no microphone or provider API. The first loopback
attempt closed before SCTP readiness and timed out; the corrected probe waits
for the data channel and uses a single bundled transport before closing.

The managed production voice process was not running after the earlier bridge
reload. An authenticated WebSocket handshake loaded it without sending a start
frame or creating a call. Its 20:05:04.727 boot record includes
`diagnostics=media-v1`; desktop session and interaction reads still returned 200.
No Codex restart or phone installation was needed. A new long provider call has
not been validated, and this update does not establish the old incident's cause
or claim to prevent future disconnects.

## Separate desktop repair verification

After the bridge reload, authenticated session reads and desktop-interaction
reads both returned HTTP 200. The latter exposed one pending real request;
this investigation did not answer it. Desktop interaction client/service tests
passed 28/28. Actual phone submission and task continuation remain separate
acceptance steps. Codex was not restarted during this investigation.
