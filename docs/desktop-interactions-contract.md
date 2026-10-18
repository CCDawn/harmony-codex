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
  `decision: approved | denied` or `answers: {questionId: [answer]}`.
- Request IDs are bridge-issued opaque tickets. The server keeps the original
  desktop request, thread, and manager-generation identity.
- A successful POST returns `{resolved: true}` only after the original desktop
  request disappears/is completed, or the async answer is visible in accepted
  desktop history. This confirms request resolution, not command completion.
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
No new conversation is created.

Unknown interactions remain visible with a desktop handling notice. Reading,
refreshing and reconnecting never approve an operation or supply an answer.

## Phone behavior and recovery

The active conversation renders a bounded, scrollable request panel. Answers
are scoped to source, thread, request and question. Submission busy state is
independent of ordinary message sending. Navigation revisions prevent a slow
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
