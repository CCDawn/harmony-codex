# Companion history and voice transcript identity

## Sources and guarantees

Official messaging entries, official call records, and live voice transcripts are
different sources. Receiving a `turn.done` event confirms the text of a voice turn;
it does not confirm persistence in the official messaging room. An official call
with `transcript_status: unavailable` must not be reported as a saved transcript.

The adapter never sends captured assistant text back as a user message. It never
replays a voice instruction to repair missing history, because that could execute
the user's request twice.

## Additive HTTP response

`GET /companion/messages` preserves the existing `entries` and `nextCursor` fields.
It adds optional `calls`, an array of:

- `messageId`, `callId`: official identities, never inferred from text.
- `createdAt`: official message time, or empty if unavailable.
- `endedAt`, `durationMs`: official metadata or null; no locally fabricated values.
- `outcome`, `transcriptStatus`: official strings, or `unknown`.
- `summary`: official message body or null; no generated substitute.

Call metadata is projected only from non-deleted messages with verified room
authors. A call-only message is returned here even when no chat text exists.
It does not become a user or assistant utterance in `entries`. Pagination remains
based on raw official messages, including call-only messages.

Old consumers can ignore `calls`. New consumers must accept its absence as an
empty array and treat unknown status values as unconfirmed, never as saved.

## Additive WebSocket identity

Companion `ready` and `transcript` events add `profileId`, `roomId`, and `callId`
when known. Existing event fields remain unchanged. The identity is captured
when the event is scheduled, before asynchronous delivery or cleanup.

New phone clients bind a voice call to its expected assistant and room and the
official call ID. They must not attribute delayed events to whichever assistant
is selected later. A legacy server without identity may still provide temporary
voice-panel text, but cannot provide a verified identity for a durable transcript.

## Local recovery versus official persistence

Phone recovery storage is only a local copy of completed voice turns. Partition
it by normalized bridge origin, assistant ID and room ID. Keep the call ID, turn
ID and original role. Never store bridge credentials in this key or log content.

Empty official history, successful polling, a successful stop call, and an app
restart are not persistence acknowledgements. Do not delete a local completed
turn simply because it is absent from official history. Do not mark it synced
without an official transcript/message identity and successful readback.

## Official room refresh behavior observed on 2026-10-08

Read-only inspection of the running official desktop client found messaging
notifications on `/celsius/ws/user`, under `calpico-chatgpt-messaging`. Message
add/update notifications invalidate room history; they do not contain a stream
of voice-turn text. Reconnection can require a full room-history refresh.

The phone currently refreshes the selected conversation every three seconds
while foregrounded outside the call panel. That REST refresh can retrieve
official messages, call metadata and summaries. Adding a notification subscriber
would reduce refresh latency, but would not supply unavailable transcripts.

The inspected official call card reads duration, outcome and summary from the
room message's call attachment. No independent transcript reader was found in
that client. This is evidence about the inspected client, not a claim that no
server-side transcript API exists. Neither a call card nor a matching text string
is sufficient to acknowledge individual locally stored voice turns.

## Verification requirements

Unit tests and builds cover projection, identity and local recovery behavior.
A full synchronization claim additionally requires matching official content on
both devices after closing and reopening the app. Call metadata alone is not
sufficient. The availability of a supported official dot transcript read/write
API remains unresolved; this change does not claim to supply one.
