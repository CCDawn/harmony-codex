# Voice barge-in playback control

Automatic input no longer stops local playback. Explicit manual playback control
remains scoped to this call and does not cancel desktop work. No unverified
Realtime/GPT-Live cancel command is sent to the private Companion API. The upstream
model keeps receiving microphone audio.

## Current correction: automatic local playback gating removed

The phone report of any small sound silencing an ongoing answer reproduces a
local state-machine defect: VAD can block output without an upstream user turn,
so no new answer arrives to release that block. A user transcript event is also
not an acknowledgement that the previous voice output has been cancelled.

CompanionSession now leaves automatic interruption to the upstream voice engine.
Microphone PCM is forwarded unchanged; neither local VAD nor user turn creation
clears or gates output. Explicit manual playback control and its identity,
revision, flush ordering and user/new-assistant recovery remain unchanged.
The ready frame reports bargeInAvailable=false for the removed local detector.
This does not assert that upstream interruption is unavailable or successful.

Offline regression first reproduced two failures (noise onset and user-turn
observation suppressing audio), then passed after removing both automatic block
entries. This is a local false-muting repair, not a verified upstream cancellation
implementation. Deployment and physical-phone double-talk acceptance are pending.

The observations and protocol details below describe the earlier implementation
and experiments; their automatic VAD behavior is superseded by this correction.

## Live verification, 2026-10-15 Asia/Shanghai

The user rejected the audible result: playback stopped, but the model continued
its answer. Treat true interruption acceptance as failed.

The speech-burst continuity repair was loaded through the project-owned voice
supervisor (`barge-in=2`). Codex Desktop was not restarted. The six focused
Python harnesses passed 65 tests. A fixed-audio phone-protocol probe received
automatic playback controls and subsequently matched the number twelve.
That arithmetic oracle overlapped with the initial counting task and cannot
prove conversational redirection. The playback controls remain observed, but
the redirection claim is withdrawn. Both probes now use the distinct phrase
"purple umbrella" for answer recognition and explicitly record
`trueInterruptionProven: false`.

A separate owned Companion call tested the documented GPT-Live
`session.instructions.append` command over an open `oai-events` data channel.
This probe bypassed local playback suppression and used fixed synthetic audio.
After delivering the entire initial question it sent one instruction to stop
the current answer and listen. The server emitted `invalid_request_error` with
a validation/parse indication; no `session.instructions.appended` acknowledgment
was observed. During the following 12-second observation, the original
assistant turn emitted 29 more transcript deltas, and the ungated output emitted
76 audible 100ms PCM blocks. The test call was then stopped and its ownership
released through the normal lifecycle.

This establishes rejection of this specific public GPT-Live request shape on
the current private Companion route. It does not establish that all private
interruption commands are unsupported, nor does it justify substituting
Realtime `response.cancel`, ending/recreating the user's call, or using an
independent assistant. True interruption remains unimplemented pending a
verified Companion command schema and behavioral confirmation. Instruction
acknowledgment alone must never release playback suppression or count as
successful interruption.

Ignored, numeric-only probe artifacts: `tmp/barge-in-live-result.json` and
`tmp/companion-yield-result.json`. No user transcript or microphone recording
was saved by these probes.

### Additional serial-response observation

The user clarified that the old answer continues streaming text while muted,
and that the new answer waits for the old one. Source inspection found no
wait-for-assistant-done condition on the microphone path: received PCM is
directly pushed to the clocked WebRTC track. The phone transcript reducer
updates each item ID independently. Playback suppression does not suppress
transcript events and does not cancel any upstream turn.

An ungated, synthetic natural-interruption trial with the unique phrase
observed the old tracked turn finish 2,140ms after the correction began, a new
user turn arrive at 2,156ms, and the distinct expected answer start at 8,046ms
and finish at 9,468ms. This reproduces the temporal order, but does not prove
that a server queue caused all of the delay: turn arrival is not input-audio
receipt or internal generation time. The original answer can span more than
one transcript turn, so a fresh assistant turn ID alone also cannot certify
that output belongs to the new request.

Current desktop code exposes `POST /tbo/{tbo_id}/runtime/pause` and `/resume`
without a turn ID or request body. The durable branch does not transmit its
UI's `interruptActiveTurn` flag. This is whole-assistant runtime control;
resume can return a different root thread. It has not been exercised and
must not be wired to automatic voice interruption as a single-answer cancel.

### Old-protocol context and proposed runtime study

The installed Codex binary and OpenAI Codex's public
`codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs` provide
an older `session.context.append` shape: optional `channel` (`speakable` or
`commentary`) and a `content` array of `input_text` objects. No single-output
cancel variant was found in the neighboring outbound enum. This is context
injection, not a documented cancellation command.

An owned synthetic Companion call accepted this shape without an observed
error. A stop/listen instruction was injected; six seconds later the distinct
correction audio was delivered. The tracked old turn ended 2,157ms after the
injection; three audible 100ms blocks were still received in the quiet window
after its first second. The distinct answer began at 14,391ms and completed
at 14,907ms. No correlated acknowledgement was observed. This is compatibility
evidence only: it does not isolate an interruption effect from natural turn
completion or demonstrate backend-task cancellation. It is not enabled in
production.

The next optional study is prepared in ignored
`tmp/companion-runtime-pause-probe.mjs` and the
`--runtime-pause-approved` branch of `tmp/companion-yield-probe.py`.
The Node tool defaults to read-only and has verified an active, unpaused
primary assistant with a root thread. Mutation requires separate human
authorization because the operation controls the entire assistant, can
interrupt other tasks, and can change its root thread on resume.

If approved, create one owned synthetic call; verify profile/room identity
and original unpaused state; pause the runtime; confirm `is_paused`; observe
five seconds; resume in `finally`; confirm `is_paused` is false and record
whether the root changed. Only after confirmed restoration, test the distinct
new voice request if the call remains alive. Stop the owned call normally.
Report voice survival, old-output cessation, new-answer recognition and
runtime restoration separately. A restoration failure must be reported;
neither Codex GUI restart nor deployment is part of this study. No runtime
pause or resume had been executed when this study was proposed.

The user then expressly approved one whole-assistant pause/resume study.
It completed with both receipts reporting applied, `is_paused` observed true
and then false, and no observed root-thread change. The voice call survived.
Between the paused-state observation and the restored-state observation the
probe received 122 audible 100ms blocks, before delivering the new correction.
That interval includes the resume request and its readback; the field named
`audibleFramesWhileRuntimePaused` therefore does not isolate exactly five
seconds in the paused state. It is not a precise paused-duration measurement.
The result does not establish cancellation of old voice output. The unique
new answer was eventually received, but its timing cannot be compared directly
to the natural-interruption test because of the runtime-control round trips.
The owned test call was cleaned up and a separate read-only check confirmed
the primary assistant remains unpaused. No global pause will be repeated
under this single-test authorization.

Additionally, the primary profile has an active root thread, but a read-only
`thread/read` through the desktop's local App Server did not return that thread.
This does not expose a usable local `turn/interrupt` target. Cloud runtime,
voice generation and the desktop local App Server must remain separate until
a verified, identity-bound remote cancellation surface is found.

### Durable-host thread control discovery

The current desktop bundle has a separate durable-host stop branch. It sends
`thread/stop` with `{threadId: primary.active_root_thread_id}` through the
manager whose host ID is `durable`, with critical priority. It does not require
a local-host read or an in-progress turn ID. On success the desktop marks its
cached conversation `needs_resume` / `notLoaded`, clears stream ownership and
also attempts to interrupt descendant agents. Those are broader lifecycle
effects than a single voice-output cancel. Its fallback to `turn/interrupt`
must not be carried over without verified turn ownership.

A new read-only live probe routed `thread/read` through the actual `durable`
host. The thread was readable, matched the primary root identity, and was
idle after the synthetic calls. A bounded `thread/turns/list` did not provide
a usable turn page. Thus the earlier local-host read failure identifies a
host-routing boundary, not the absence of all cloud thread controls.
No `thread/stop`, `turn/interrupt` or descendant cancellation has been executed.
The mapping between a spoken Companion transcript turn and a durable backend
turn remains unverified; stopping the durable root must not be represented
as stopping the voice engine.

## Negotiation and compatibility

The phone sends `playbackControlVersion: 1` on its existing `start` frame.
Only the exact integer 1 enables bridge VAD and playback gating. Legacy start
frames retain their existing clear-buffer behavior. New ready frames include
`playbackControlVersion: 1` and `bargeInAvailable`, which indicates whether the
fast WebRTC VAD is available. Legacy ready frames retain their existing shape.
Install the pinned dependency with the voice runtime's Python using
`voice/requirements-barge-in.txt`. Missing or failed VAD is explicit; confirmed
user-turn events can still clear output, without an amplitude-only fallback.

## Playback events

The server sends additive JSON control events on the existing ordered socket:

- `type: playback`
- `state: blocked | resumed`
- `revision`: strictly increasing nonnegative safe integer per call
- `source: manual | user_speech | user_turn | assistant_turn`
- `profileId`, `roomId`, `callId`: the already verified call identity

The phone accepts controls only after ready and only for its bound call identity.
Wrong identity, stale/duplicate revisions, unsupported values and pre-ready
controls cannot change playback. Server suppression composes with local flush
and other suppression tokens. `resumed` cannot bypass an unfinished flush.

## Detection and output lifecycle

WebRTC VAD uses 16 kHz mono PCM16 input, 20 ms frames, mode 2, four consecutive
speech frames (80 ms), and ten negative frames (200 ms) to re-arm. It runs only
throughout a negotiated ready call to retain speech-burst continuity across
playback blocking and recovery. Only a new onset while playback is speaking and
not already blocked triggers interruption. Detection occurs
on the bridge, after phone capture and uplink delay; it is not an 80 ms audible
stop guarantee. VAD does not remove speaker echo. The phone uses communication
capture/playback, but device acoustic echo cancellation still needs validation.
Native VAD hangover is reset between enabled intervals, preventing a prior
speech burst from making later silence falsely trigger. Output blocking itself
does not disable the detector or re-arm one ongoing utterance.

A manual interrupt, fast speech detection or confirmed user turn clears pending
bridge output and blocks further playback. Remote media is drained while blocked
so old audio does not accumulate. The microphone path remains active. The phone
clears its queue/cursor, silences subsequent write callbacks and serializes
renderer flush; failed flush retires the old output renderer before rebuilding
output, preserving microphone, socket and call ownership.

Recovery requires a confirmed user turn and a fresh assistant `turn.created`
event. An old/duplicate assistant event, assistant completion or unrelated new
assistant turn before the user cannot release the gate. The resumed control is
sent before new PCM is admitted to the ordered phone socket. PCM selected before
an interrupt is rechecked before send. The server and phone each cap application
output buffering at one second, measured in bytes rather than message count.
Overflow drops oldest complete samples and can clip speech; this is a maximum
buffering bound, not a promise of audible latency or lossless overload behavior.

## Evidence boundary

Companion control events and RTP media do not carry a verified shared response
identifier in this adapter. A fresh assistant turn is an observed conversational
boundary, not an upstream cancel acknowledgement or proof that every subsequently
decoded RTP sample belongs to that turn. Late jitter-buffered media around
recovery remains a real-device acceptance risk. This implementation never invents
a timeout to assume upstream cancellation, and never hangs up/recreates a call
to implement interruption.

Acceptance must cover audible stop latency, no echo-only false triggers, intact
user opening words, continued microphone input, repeated interruptions, new
answer playback, speaker/headset routes, mute and screen-off operation. Numeric
queue/VAD/flush evidence and tests do not replace audible device validation.
