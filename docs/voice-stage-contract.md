# Voice connection stage events

The `/voice` WebSocket remains an opaque byte tunnel through the Node bridge. The Python voice server may send the following optional JSON text events to report connection progress. Existing clients can continue to rely on `ready` and `error`; this is an additive, compatible change and does not require a protocol-version change.

## Events

| Event | Fields | Meaning |
| --- | --- | --- |
| `{"type":"progress","stage":"assistant"}` | `type`, `stage` | The server has begun starting its Companion helper, discovering the personal assistant, and negotiating the voice offer. |
| `{"type":"progress","stage":"media"}` | `type`, `stage` | The remote WebRTC description and Companion attach step completed. The server is now waiting for realtime and WebRTC media readiness. |
| `{"type":"ready","profileName":"…","roomId":"…"}` | Existing fields | Both realtime and WebRTC media are connected. This remains the server's only success-ready event. |
| `{"type":"error","failureStage":"assistant","message":"个人助手准备失败"}` | Existing `type`/`message`, optional `failureStage` | Assistant helper, discovery, or offer setup failed. The message is fixed and contains no original exception text. |
| `{"type":"error","failureStage":"media","message":"语音媒体连接失败"}` | Existing `type`/`message`, optional `failureStage` | Media readiness failed after remote description setup. The message is fixed and contains no original exception text. |

Progress events are emitted in this order: `assistant`, then `media`, then `ready` only after `wait_media_connected()` succeeds. A failure emits the applicable progress event(s), followed by `error`; it never emits `ready`. The bridge forwards these frames unchanged and does not parse or log their contents.

## Client compatibility

- Treat `progress` as optional. Older clients may ignore it and continue waiting for `ready` or `error`.
- New clients should recognize only the documented `stage` values. Ignore unknown event types, unknown fields, and unknown stage values while keeping the existing connection timeout behavior.
- Treat `failureStage` as optional so older servers remain valid. Map the known `assistant` and `media` values to local UI text; do not display arbitrary server exception text as a diagnostic.
- Do not mark the call as listening on receipt of `progress`, or on `ready` alone. `ready` confirms remote media; microphone capture success remains a client-side condition.

## Upstream HTTP failures

Error events may include optional numeric `httpStatus`, accepted only from the helper's strict `Companion HTTP NNN` format. No response body, exception text, credential or SDP is forwarded. Clients map 502/503/504 to temporary Codex voice unavailability, 401/403 to access/login checks, and 429 to request limiting; other values retain the stage fallback. The server logs the allowlisted RPC operation and HTTP status only. Call creation is never automatically replayed on these failures.

## Call ownership and failed teardown

Startup now reads phone control frames concurrently with assistant discovery and
media setup. Stop or disconnect cancels the pending setup before `ready` can be
emitted. A create RPC already submitted is drained within its existing deadline
so a late allocation receipt can be stopped; local media is released before
waiting for that receipt. Until teardown completes, another connection receives
the existing `busy` event instead of racing the previous allocation.

Optional error diagnostics are additive: `errorCode` is one of `timeout`,
`cdp_connection`, `http_error`, `unknown_error`; `operation` identifies the RPC
method, and `stage` can narrow it to `discover`, `history`, `create`, `attach`,
`stop`, `reconcile`, or `unknown`. Unrecognized diagnostics are discarded.
RPC deadline failures report `timeout` without guessing the upstream stage.
Existing phone versions may ignore these fields. Logs include elapsed RPC time,
never the original error body, credentials, SDP or conversation content.

The start RPC has a 110-second overall budget for sequential identity reads,
optional orphan reconciliation and call creation. Discovery and stop desktop
requests retain their 30-second timeout; creation has a 40-second native request
deadline and 45 seconds for delivery through CDP. Other RPCs retain 35 seconds.
The native request receives an abort signal, so expiry cancels the fetch rather
than only dropping the CDP response waiter. A real HTTP 503 observed around the
old 30-second cutoff is preserved for the existing phone error mapping.
This avoids killing
the helper at 35 seconds while a valid multi-step start is still pending. It
does not replay failed creates or guarantee receipt recovery after an ambiguous
upstream timeout. The last discovered identity can be used to select owned
orphan receipts; the client still refreshes and validates identity before every
new allocation.

The helper durably records received call allocations under the ignored `voice/voice-scratch/owned-calls/` directory before exposing them to the phone. Records contain only assistant/room/call identifiers and the owning helper PID, never transcripts, SDP or credentials. A successful stop removes its receipt; a failure retains it across helper or server restarts. Before creating a new call, the helper reconciles receipts for the same assistant room whose owning process has exited. Live helper ownership blocks competing creation. Failed orphan reconciliation preserves evidence and defers further cleanup; it does not block a newly requested call, retry call creation or stop an unrelated call. Local audio and WebRTC close before remote cleanup; stop uses the normal RPC timeout instead of the old five-second deadline.

An orphan stop failure does not establish that new calls are unavailable. After checking all matching owners, failed orphan cleanup is marked with `cleanupDeferredAt` and retained for diagnosis. It is not retried during subsequent call starts. The client clears the orphan identifier before allocating a new call, so normal stop and helper shutdown affect only the new allocation. Journal read/write failures still fail closed. No automatic call-create replay is introduced.

This cannot guarantee recovery of an allocation for which the create request never returned a usable call receipt. Such ambiguous creates are not automatically replayed. Stale records with ambiguous remote errors remain pending rather than being silently declared ended.

## Media disconnect diagnostics

These are server-side logs only; the phone protocol and timeout/retry behavior
are unchanged. `media-state` records a random session tag, elapsed time,
allowlisted peer/ICE/DTLS/data-channel states and local-release/requested-stop
flags. Local-release means cleanup has begun, not that it has succeeded.
`media-control` records selected upstream lifecycle/error event categories and
allowlisted error codes/statuses. Unknown values remain unrecognized. It does
not record messages, transcripts, event IDs, SDP, addresses or credentials.

`media-dtls-signal` extracts only exact templates from the installed aiortc
logger, without formatting log arguments. New debug verbosity is filtered out
of ordinary handlers; pre-existing configured logging remains unchanged.
`remote_shutdown` means the library observed a remote DTLS shutdown signal;
it does not establish the provider's business reason. The signal is process
scoped; correlate with the nearby tagged state/control sequence. A missing
signal cannot establish a network failure or exclude a remote shutdown, because
transport errors and future library template changes can lack this signal.

The startup log's `diagnostics=media-v1` marker confirms the running server
loaded this diagnostic revision. Offline tests and local loopback media can
validate logging behavior; neither proves a long provider call no longer drops.
