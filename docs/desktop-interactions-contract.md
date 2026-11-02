# Desktop approvals and questions

The phone reads pending requests from the existing manager used by Codex Desktop.
An initialized native App Host manager is preferred. Desktop builds using the
legacy channel resolve the already mounted UI provider's manager instead. The
fallback discovers its family/export from the current desktop bundle, validates
the local host and required methods, and never constructs a manager. Missing or
incompatible providers fail closed with 503. Neither path creates an independent
app-server or requires a phone-created bridge run. Read-only discovery must not
resume or start a turn.

## Authenticated endpoints

- `GET /api/desktop-interactions?threadId=...` returns `{requests: [...]}`.
- `POST /api/desktop-interactions/:id` accepts `threadId` and either
  `decision: approved | denied`, `answers: {questionId: [answer]}`, or for
  supported async questions `skipQuestionId: questionId`. Skip is a separate
  operation and cannot be combined with answers or a decision.
- Request IDs are bridge-issued opaque tickets. The server keeps the original
  desktop request, thread, and manager-generation identity.
- A successful POST returns `{resolved: true}` only after the original desktop
  request disappears/is completed, or the async answer is visible in accepted
  desktop history. For a skip, it means only that the selected question
  state was written and read back as skipped; other questions can remain
  pending. It does not confirm that the model or turn has finished.
- A stale ticket returns 409. Invalid answers return 400. Unsupported request
  types return 422. Transport failure or an unconfirmed reply returns 503.
  Writes are never automatically retried.

## Supported interactions

Command and file approvals offer one-operation accept/decline. File approval
requires file context. Permission approval grants exactly the requested
profile for the current turn; denial grants an empty profile. Session-wide
approval and policy changes are not inferred from a one-time approval.

Blocking questions use the original native `replyWithUserInputResponse`
method and its original question IDs. Async questions use the official
`send_user_message_question_reply` envelope and the desktop manager's
`sendFollowUpMessage` entrypoint with
`turnTrigger: send_user_message_async_question`. The desktop coordinator
steers the running turn or starts a follow-up in that same conversation.
No new conversation is created. For async requests, `supportsSkip` is true
only when every currently presented question has uniquely identifiable,
readable and writable native state for each mounted entity alias, plus the
native scope and panel actions. Canonical history supplies the real Desktop
entity key; only legacy history uses `turn:<turnId>`. An ambiguous canonical
identity never creates a fallback entity. If a current question state is
missing, Desktop’s own synchronizer may initialize it using the complete
active-turn questions and accepted answer history through a verified mounted
scope. Existing drafts and skipped state are retained by that synchronizer.

Skipping synchronizes the selected question across the already mounted
same-turn aliases, clears that question’s drafts and reads back each state.
When it is selected in the Desktop input panel, the bridge uses native actions
to advance or close the panel. Other questions' drafts are preserved and are
never submitted automatically. Missing or ambiguous scope, conflicting
bindings, incomplete answer evidence, replaced bindings and stale tickets fail
closed. Refresh after each skip to obtain any remaining questions and a fresh
ticket. A skip is native renderer state: it is not promised to survive a
Desktop process restart. Bridge reconnect reads the same mounted native
entities again. A distinct alias mounted after a skip may have fresh state;
the bridge does not silently overwrite it or infer an intent to reopen.

Unknown interactions remain visible with a desktop handling notice. Reading,
refreshing and reconnecting never approve an operation or supply an answer.

## Phone behavior and recovery

The active conversation renders a bounded, scrollable request panel. Native
async drafts and submission busy state use the thread/turn/item identity, with
answers additionally keyed by question, so replacing a transport ticket does
not discard another question's draft or allow concurrent group submissions.
Other interactions retain their source/thread/request/question scope.
Submission busy state is independent of ordinary message sending. Navigation revisions prevent a slow
response from a previous conversation replacing the current panel.

Each refresh reads the native pending snapshot, so reconnecting can recover
existing requests. A retired manager generation expires old tickets. Legacy
provider, family binding, or manager replacement also rotates that generation;
replacement during a read cannot return a ticket for the old manager.
The bridge checks the pending request again before dispatching a response.
Concurrent responses are serialized per thread, and the native manager
remains the authority when desktop and phone both act.

The official async follow-up API has no question-level atomic claim. A desktop
answer arriving inside its resume/prepare await can race a phone answer.
Conflicting accepted answers observed on readback return 409 and are never
retried, but this cannot guarantee exactly-once submission across both UIs.
The integration uses internal desktop runtime capabilities, with fail-closed
capability checks; a future desktop update may require an adapter update.

Human approval/input waiting flags renew the active task's idle lease only
after a successful official status read. Failed status reads stop renewal and
retain the ordinary disconnect timeout.

## Verification boundary

Unit/contract tests use controlled native-manager fixtures. An ArkTS build and
HAP installation alone do not prove native desktop transport, phone rendering,
or continuation of a real task. Those require an available desktop connection
and a harmless, explicitly identified test request; real approvals must not be
answered by the debugging agent.

## Native continue control

Latest-turn selection compares the desktop manager's current canonical/optimistic
turn with the persisted latest page. The page can lag a confirmed native
interruption. A newer live identity must not be replaced by that older page;
if different identities have no reliable time ordering, eligibility stays
unknown. HTTP status, SSE status and the final native write guard use the same
chooser.

`GET /api/codex/threads/:id/continue-status` is read-only and returns
`{threadId,turnId,state,canContinue,reason}`. It does not call thread/resume or
start a turn. Playback eligibility follows the desktop: an interrupted latest
turn or a supported recoverable failure, no active turn or pending submission,
and confirmed absence of a goal. Missing capability or goal evidence disables
the action. Empty phone input and attachment state are an additional UI guard.

`POST /api/codex/threads/:id/continue` accepts a UUID `operationId` and
`expectedTurnId`. The bridge revalidates canonical thread, latest turn, goal and
mounted-manager lease, then reuses the desktop's follow-up context and native
`startEmptyTurn` with `turnTrigger: resume_interrupted_task`. No synthetic user
message is sent and no phone draft is consumed. A newer active turn is never
steered by this action.

Responses contain the operation/thread/expected-turn identities, observed
turnId, active, state and reason: HTTP 200 confirmed, 202 uncertain, or 409
rejected. The phone preserves a structured 409 rejection; it does not mistake a
known no-write outcome for a lost response. Invalid input remains HTTP 400.

The bridge serializes operations per thread and writes an atomic journal before
entering any native method that can start work. The same operation ID returns
its stored result. An already-continued expected turn cannot be restarted with
a new ID; an unresolved writing/uncertain record also blocks automatic resend.
The phone does not retry a continuation write after reconnect or a lost receipt.
Only a newly observed native turn clears its local uncertain-turn guard.

## Reading position during expansion

Expanding or collapsing a full message, tool output, tool group or Markdown
block enters manual reading mode before the expanded-entry state changes.
Content-height observations and incoming stream updates must not scroll to the
latest message while that mode is active. The existing viewport stays in place
as additional content extends below it. The expand/collapse button itself can
move with the added content; it is the reading position that is preserved.

Following resumes only after an explicit return-to-bottom action or a user
scroll that reaches the actual bottom. Programmatic layout/edge callbacks do
not re-enable it. A fold action also clears any pending older-history anchor
so delayed layout restoration cannot override this reading intent.

`test/sessionContentExpansionScroll.test.js` covers synchronous native-layout
callbacks during all four expansion actions, later stream updates, collapse,
and the two explicit ways to resume following. Device screenshot evidence is
recorded separately in the current acceptance artifacts.

## Recent history when the persisted page lags

The desktop's mounted canonical history can contain a completed turn that is
already in the rollout but absent from `thread/turns/list`. Recent phone history
can supplement the validated official page with this same manager's complete
text-only canonical tail. This is a read-only operation: it never resumes a
thread, sends a message or rewrites the rollout.

The supplemental read has a 500 ms budget and limits of four turns, 256 items
and 512 KiB. Thread and manager identity are checked again after projection.
Only complete supported terminal turns leave the renderer. Unsupported tools,
media, missing canonical islands and over-limit data retain the official page
and produce a fixed diagnostic without transcript content.

New turns require a matching predecessor/page-tail anchor and reliable time
ordering. Same-turn items use real item identities; older native copies cannot
replace newer page text. Only validated full terminal turns provide completion
evidence. Historical before/after reads do not use this supplement, and opaque
pagination cursors remain owned by the official endpoint.
