# Personal assistant text submission

`POST /companion/messages` is an additive operation behind the existing bridge
authentication gate. It writes to the current official personal assistant's
messaging room. It does not create a Codex thread or route through the ordinary
session outbox. Existing `GET /companion/profile` and `GET /companion/messages`
responses and pagination are unchanged.

## Request

The JSON object contains `profileId`, `roomId`, `text`, and `requestId`.

- `profileId` and `roomId` must be nonempty strings, at most 512 characters,
  matching the official active personal assistant returned by discovery.
- `text` must be a nonblank string, at most 20000 UTF-16 code units. The original
  text, including line breaks and surrounding whitespace, is preserved.
- `requestId` must be a UUID (version 1 through 8, standard variant). The bridge
  normalizes it to lowercase. Generate it once when the user submits a draft and
  retain it with that exact text and target. Do not generate a new ID on timeout.
- The complete JSON body is limited to 128 KiB. Attachments, page context,
  replies and voice transcript persistence are outside this operation.

The bridge checks both discovered identifiers, then checks the official primary
profile again in the same desktop evaluation immediately before the write.
Missing, changed or inactive personal assistant identity prevents the POST.

## Official API mapping

Read-only inspection of the desktop messaging implementation in the local
research snapshot on 2026-10-17 confirms this request:

`POST /messaging/rooms/{room_id}/messages`, with path `room_id=roomId` and body
`content.text=text`, `request_id=requestId`, `idempotency_token=requestId`, and
`timezone_offset_min=new Date().getTimezoneOffset()` in the desktop renderer.
The official client accepts the top-level returned message `id`. This adapter
disables automatic request retries and uses a 25 second request cancellation
signal inside a 30 second desktop evaluation wait.

The inspected official send flow also conditionally prepares Sentinel headers,
an app attestation challenge and routing metadata. This adapter uses the existing
authenticated API client and does not fabricate these values. Whether the current
server requires additional send preparation remains a live acceptance boundary;
a server rejection must not be bypassed by imitating verification headers.

No supported request-ID lookup query was established by this inspection. This
implementation does not guess such a query or infer submission from equal text.

## Receipt and errors

HTTP 200 returns exactly `requestId`, `state`, and `itemId`:

| state | itemId | Meaning |
| --- | --- | --- |
| `submitted` | `room:<official message id>` | The official POST returned a concrete server message identity. |
| `uncertain` | `null` | Acceptance cannot be confirmed; the request may already have reached the server. |

`submitted` confirms server submission only. It does not confirm delivery to,
reading by, a reply from, or completed work by the assistant. Reconcile the
optimistic user entry against the existing history `itemId` before replacing it.
Optional official response `room_id` and `request_id`, when present, must match.
A malformed or mismatched receipt, timeout, lost CDP result, HTTP 408 or HTTP 5xx
produces `uncertain`. The bridge never converts these into a definite failure or
automatically resubmits them.

Invalid input returns HTTP 400; changed identity or reusing a request ID with
different content/target returns HTTP 409. A definite upstream HTTP 4xx rejection
other than 408 remains a failed HTTP request. A discovery failure occurs before
the official POST and returns HTTP 502. Error bodies contain only a safe generic
message. HTTP 413 denotes a body that exceeded the local limit.

## Duplicate protection and recovery boundary

Within one service lifetime, the bridge binds each request UUID to the hash of
its exact profile, room and text. Concurrent or repeated copies reuse the same
promise and receipt, including uncertain outcomes and definite rejections; they
never trigger another official POST. The ledger retains at most 4096 request IDs
and returns HTTP 503 before writing when full, rather than evicting IDs that could
later be replayed. The ledger stores no original text after the operation ends.

The in-memory ledger resets when the bridge restarts. The official request and
idempotency UUID remain the same if a client repeats the same operation across
that boundary. This code does not claim a verified server retention period for
idempotency tokens. Clients must keep uncertain submissions visible and check
official history; polling, reconnection and relaunch must not replay them.
There is no automatic or explicit resend action in this bridge operation.

Offline tests validate the generated official API request, identity gates,
duplicate prevention and receipt states. They do not establish live server
submission, desktop rendering, phone rendering or assistant response behavior.
