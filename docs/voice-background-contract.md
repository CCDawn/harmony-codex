# Locked-screen voice lifecycle

The supported flow is to connect while the application is foreground, then keep
the existing call active when the screen locks. Locking or hiding the page does
not hang up the call. This does not implement initiating calls from the lock
screen, always-on wake words, or automatic call recreation after interruption.

The phone owns an `avPlaybackAndRecord` continuous task for the call, using
`SUBMODE_VOICE_CHAT_NORMAL_NOTIFICATION`. The microphone and renderer use the
communication audio source/usage. The data-transfer task is separate and is not
used as a substitute for audio background eligibility.

System cancellation is matched to the continuous task ID and call generation.
An unrelated or stale cancellation cannot end the active call. Intentional stop
suppresses its own cancellation notification. A failed stop retains ownership
so it can still be cleaned up. If the system revokes the active task, the call
releases its media and reports an ended call rather than continuing to show
listening.

An audio PAUSE or STOP interruption ends the call with an explicit system-audio
message. Ducking and late events from a previous call do not end it. There is no
automatic microphone restart after the user has muted or ended a call. Audio
interrupt handlers are removed during normal release.

## Microphone mute

The call service owns the microphone mute state. The page receives the current
value when its callbacks attach and whenever mute changes; its button toggles
the service value, not a separate page value. Retrying an ended or failed call
preserves the user's mute choice. Opening a fresh call explicitly clears mute.

Both capture batching and the binary send entrypoint reject new audio while
muted. Changing mute clears partial microphone batches, so unmuting cannot
replay pre-mute samples. Already submitted network frames cannot be recalled;
the assistant may finish responding to speech received before the transition.
Mute affects microphone upload and leaves assistant playback available.

Connection liveness is independent of microphone upload. The server probes the
phone with WebSocket Ping and records only acknowledged Pong responses. The
bridge and relay forward the raw connection, including control frames. A muted
phone with working Pong responses stays connected without sending PCM. The
90-second idle deadline expires only when neither PCM nor an acknowledged Pong
arrives; active PCM also tolerates delayed mobile control frames. An old Pong,
outbound assistant audio, or merely sending Ping cannot keep a dead phone alive.
This transport rule does not override system background-task cancellation or
an upstream service ending the call.

Validation must distinguish SDK-mocked tests, signed HAP compilation, installed
version, physical screen-off audio callbacks, and audible two-way conversation.
Silence/PCM bytes alone do not prove speech recognition or audible replies.
Charging and connected HDC may affect power behavior: a controlled screen-off
test is not proof of unplugged battery-saver endurance.

Final transcript storage currently remains in the existing verified-identity
page callback. Page disappearance does not unregister that callback. This change
does not claim durability across process termination, or synchronization of full
voice transcripts to the official desktop history.

References: OpenHarmony application-dev/task-management/continuous-task.md;
installed BackgroundTasks Kit and Audio Kit SDK declarations. Endurance checks
should cover silence followed by speech, 1/5/15 minutes locked, accessory/network
changes, unlock/history readback, and final microphone/task release.
