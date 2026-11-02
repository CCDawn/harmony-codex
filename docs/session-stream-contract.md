# Phone live conversation delivery

Ordinary phone tasks subscribe to `GET /tasks/:id/events`; native runs use
`GET /api/codex/runs/:id/events`. The existing JSON endpoints remain available
for authoritative metadata, approvals, history recovery and older clients.

Business SSE frames keep their existing event name and JSON event object and
add `id: <seq>`. Sequences belong to one task/run. `afterSeq` takes precedence
over `Last-Event-ID`; omitting both preserves legacy history replay. Clients
advance only after applying a complete event, reject duplicate sequences and
cancel the old subscription when its visible conversation or credentials change.

`stream.control` frames have no SSE ID. `reason: gap` requires snapshot/event
pagination recovery before reconnecting. `reason: terminal` requires a final JSON
snapshot and stops the subscription. `reason: reconnect` requests a new handshake
using the client's last applied sequence. Recovery failures use bounded polling,
not an immediate connect/snapshot loop. Assistant text remains intact in JSON
event pages even when diagnostic/tool fields are summarized.

The server flushes headers, sends heartbeat comments every 15 seconds and bounds
connection lifetime and slow-reader buffering. Each reconnect uses a fresh TOTP
code. The phone parses UTF-8 and SSE framing incrementally; HTTP chunks are not
message boundaries. Polling remains a fallback when streaming is unavailable.

Viewing a desktop-originated turn does not create a phone task. Such a view
subscribes to `GET /api/codex/threads/:id/events`, using the existing authenticated
desktop notification dispatcher without starting or steering a turn. Assistant
item start/delta/completion notifications update a bounded message accumulator.
Initial and terminal repair use the official `thread/turns/list` request
(`limit: 1`, `itemsView: full`), without reading the whole conversation or polling
for each delta. Non-consuming replay of retained desktop notifications shares
renderer-epoch and sequence identities with live delivery, so overlap cannot
append a token twice. `session.message` carries `{ entry }` with
the official thread, turn and item IDs and the current complete item text.
The phone replaces that item as its text grows; it never concatenates snapshots
or invents a task ID. Retained item-start events restore the prefix when joining
mid-answer. If the bounded desktop cache no longer contains the start, the
observer keeps an unknown-prefix marker and waits for authoritative completion
instead of displaying a truncated suffix as a complete answer.

Official tool items from `item/started` and `item/completed` also use
`session.message`. They reuse the existing official-history projection, with
`role: tool`, the same thread/turn/item identity, and structured `toolItems`.
This displays a running tool even when `thread/turns/list` has not included it
yet. Its explicit native status determines the displayed status; `liveKind`
records the item lifecycle boundary only. Missing status remains unknown, and
missing title fields do not produce a made-up tool row. The phone applies
status-only updates without duplicating the item, rejects late running replay
after completion, and lets a full official terminal turn retire live tool state.
Agent activity uses its original lifecycle records and child identity rather
than treating tool-call completion as child-agent completion.

An active turn may already contain many completed commentary items. A snapshot
item with a successor is completed even when `item.status` is omitted; only a
final assistant item may remain streaming. A later item start (including a tool
or reasoning item) closes the preceding assistant's output phase, and changing
turns closes the old output before discarding its cache. Completed item evidence
is monotonic across retained starts, deltas and stale snapshots. The phone also
limits running footer status to the current content, so historical paragraphs
cannot each inherit the enclosing turn's running state.

`session.invalidate` requests normal history/interaction reconciliation.
This stream has no persistent cursor: reconnect performs a fresh official read.
Closing a view releases only its own subscription. Heartbeats, connection lease
and bounded slow-reader shutdown apply here too. A matching running phone task
retains its task stream instead, so the two text sources never compete.

The selected-thread observer budgets retained turn state separately from queued
network output: 4 MiB and 256 KiB respectively. Snapshot publication waits for
socket drain between frames instead of queuing the complete turn synchronously.
Cancellation, lease/backpressure timeout and turn changes release these waits.
An oversized item or retained turn enters history repair for that turn: body
caches are released, status continues, and a coalesced invalidation requests
canonical history. Re-reading the same oversized snapshot does not repeatedly
invalidate or reconnect. Actual item/turn boundaries can still request repair;
text deltas do not cause history reads. A new turn restores ordinary streaming.

Personal assistants subscribe to
`GET /companion/events?profileId=<id>&roomId=<id>`. The bridge validates the active
assistant and retains its own listener on the desktop's existing authenticated
messaging topic. Initial subscription and real upstream message notifications
trigger message reads. No timer polls the upstream messages endpoint while this
subscription is healthy.

`companion.message` carries `{ entry }`, using the official `room:<message-id>`
identity. Updated text replaces the same message rather than adding a bubble.
This upstream interface supplies message-update notifications, not token deltas;
the refresh granularity follows the official message updates. There is no
invented durable cursor. On reconnect/gaps the phone repairs official history.
The listener has a 60-second lease and releases only its own subscription.

Phone conversation drafts are held in memory by bridge identity and conversation
(or new-conversation project). Switching pages preserves text and attachments;
submitting transfers their ownership to the recoverable optimistic/outbox record.
An acknowledgment for an earlier page cannot clear the current draft. Process
restart persistence is outside this draft store's contract.

Durable queued and uncertain submissions older than 24 hours move to `held`.
For uncertain writes, age starts at the last delivery attempt; for queued writes,
it starts at creation or the latest explicit edit/retry. Queue-blocking checks
do not refresh that age. Held entries preserve their payload, submission ID and
delivery evidence, remain visible in the pending queue, and cannot block newer
submissions or resume automatically. Users can cancel them or confirm a retry;
retry first checks for an existing official delivery receipt. An inconclusive
receipt can still mean the message was delivered, so the phone warns about a
possible duplicate before this explicit retry.

Reopening a conversation restores pending user bubbles from durable submissions
and reconciles them with official history. Queue, blocked, dispatching and
uncertain states appear below the bubble. Historical held entries stay in the
queue panel instead of reappearing as new conversation messages.

Phone submissions with a submission ID return after durable enqueue. Desktop
readiness, target verification and ordered dispatch belong to the existing outbox
worker; the phone does not run another readiness/recovery check before enqueue.
The same submission ID and payload identify a retry. Reusing that identity with
a different payload is a conflict, not another message. Recovered uncertain
entries are saved before background receipt reconciliation begins. Each receipt
state change is saved before the next asynchronous receipt read and before a
success log is emitted.

An input is accepted only by its own native start/steer acknowledgement or exact
submission journal record. A matching message body and timestamp are insufficient.
Acceptance and official history persistence are separate facts. Accepted inputs
are not automatically resent when generation fails; unresolved deliveries retain
their identity while waiting for confirmation. Several inputs can share one run,
so acknowledgements and pending state are retained per submission, including
across task event gaps.

Navigation reads and task adoption capture the navigation revision and Bridge
identity. A stale A request cannot own a later B view or a later visit to A.
Sending captures its original target before asynchronous fingerprint reads;
switching views does not redirect that submission or its status to the new view.
Send, interrupt and history receipts follow the bottom only while the reader is
following it. History pagination is scoped to the view and cursor that started it.

Timeline data retains its stable message identities. The V1 page uses Repeat
full-loading mode and passes the full `RepeatItem` to its builder, following the
[OpenHarmony Repeat guide](https://github.com/openharmony/docs/blob/master/en/application-dev/ui/rendering-control/arkts-new-rendering-control-repeat.md#node-updatereuse-in-full-loading-mode).
This mode needs a changed render key to update an immutable snapshot and reuses
the removed-key node rather than destroying it as ForEach does. Passing only
`RepeatItem.item` to the builder or keeping an unchanged full-loading key can
freeze its contents. Node reuse, continuous text updates and detached reading
position must be checked together on the device.

## Desktop and session status

`GET /api/codex/runtime-events` adds an authenticated, read-only global SSE
view. One bridge observer shares the existing desktop notification drain for
all connected phones. Official thread-status and turn-lifecycle notifications
coalesce canonical runtime reads within 120 ms; a five-second read also detects
connection changes when no conversation emits an event. Text deltas do not
trigger runtime/history reads. Each handshake sends a fresh snapshot and has no
durable sequence cursor.

`runtime.snapshot` carries `{snapshot,desktop:{connected,state},observedAt}`.
The snapshot retains its existing epoch, revision and generatedAt checks. Failed
reads report a stale cached snapshot or null, rather than inventing idle or
completed sessions. The optional `nativeState` retains official `notLoaded` and
`systemError` evidence alongside the legacy state projection. A phone-bridge
connection alone does not establish a ready desktop.

`runtime.transition` carries `{threadId,turnId,state}` only for an explicitly
completed/failed turn observed running or started by this observer. It supports
local completion alerts for desktop-originated work without a phone task.
Stable thread/turn identities deduplicate lifecycle and phone-task alerts;
idle, unknown and interrupted states cannot produce a successful completion
alert. Cloud delivery still requires a configured Push Kit service and a ready
registration covering that thread.

Selected-thread streams additionally emit `session.status` with
`{threadId,turnId,state,canContinue,reason}`. Initial and terminal reconciliation
reuse the bounded latest-turn read. A status-change notification without a turn
ID invalidates continuation eligibility until canonical reconciliation finishes.
Changing the phone's selected conversation or bridge credentials retires the
old owner; late reads and frames cannot update the replacement view.

Assistant text, tool groups and expanded output share the same content column.
The optional tool field `displayCommand` contains the unwrapped, untruncated
shell command for the native-style Shell output panel; `args` still retains the
original invocation for copying. User bubbles retain their existing independent
width cap. These optional fields and new events do not change older JSON APIs.

## Large conversations and landscape switching

Phone history requests opt into `view=session`, which returns one complete
`{session}` payload. Requests without this parameter retain both legacy aliases
`{thread,session}`. The phone initially requests the latest full official turn;
turn items are never truncated, and official cursors still page older turns.

Canonical entries, optimistic reconciliation and tool grouping remain complete.
The phone mounts the recent 40 display rows, then reveals earlier local rows
before requesting another official page. A stable row key fixes the start of
this window while new messages arrive. Local expansion uses the same scroll
anchor for canonical, optimistic and failed rows. Switching updates the selected
sidebar ID immediately and hides the old conversation's controls until the
new detail is available. Model settings load independently of this transition.

Collaborator headers share tool-row typography. Exact official agent activity
paths optionally supply `agents[].displayName`; `agents[].name` still preserves
the original identity. Avatar initials derive from this displayed name and do
not imply that an official profile image exists.
