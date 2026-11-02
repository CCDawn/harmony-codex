# Phone initiated link recovery

The phone uses the existing HTTPS relay URL with a separate control route:
`/control/v1/targets/{targetId}`. The relay routes `control-pc` connections by
target without falling back to the conversation bridge pool. The Windows
control worker listens only on loopback port 8788 and uses its own SSH forward
to the relay. Stopping the conversation bridge or exiting the tray leaves the
worker available. The computer must remain powered on and reachable.

## Requests and results

- `GET /status` returns the authorized caller's active and most recent repair.
- `POST /repairs` accepts `requestId`, `mode`, `sessionId`, and
  `confirmHardRestart`, then returns HTTP 202 and a durable job.
- `GET /repairs/{jobId}` reads that job. Disconnecting the phone never cancels
  the computer's repair. The phone resumes by querying, without resubmitting.

`mode` is `auto` or `hard`; `hard` requires `confirmHardRestart:true`. Automatic
recovery follows the existing guardian restart permission. Existing business
repair endpoints remain compatible. Calls require the same token and TOTP as
the paired conversation connection, including for loopback requests. Device
revocation is read fresh from the bridge-owned registry, without writing it.

The server admits one active job. Reusing a request ID with the same payload
returns the original job; changing its payload is a conflict. Another device's
active job cannot be adopted. History is bounded to 200 jobs and 2000 request
aliases. Saturated alias history rejects new requests rather than replaying an
old repair. Restarted workers mark interrupted jobs unconfirmed and never
blindly replay them.

Success requires bridge health, a readable session list, and the intended
session verified through its actual runtime. Desktop execution also requires a
live desktop and a verified target. Explicit app_server execution verifies
the actual target detail without requiring CDP. After a successful job, the
phone additionally reads the target through its public conversation route.
An available management connection alone is never reported as recovered chat.

## Local provisioning

Copy `tools/harmony/control-agent.example.psd1` to the ignored
`control-agent.local.psd1`; configure a trusted SSH destination and existing
identity file. It owns a separate forward on 11978. The worker uses the
existing local relay token and generated bridge credentials; no private key
contents or credentials are put in process arguments.

`tools/windows/mobile-control-agent.ps1 -Action Ensure` registers an interactive
logon task and starts the hidden worker. The tray calls the same idempotent
entrypoint on startup and periodically. `-Action Status` returns sanitized
worker liveness; the authenticated HTTP route proves end to end availability.
Missing configuration leaves an unavailable state without plaintext fallback.

When HTTPS is terminated by Nginx and `/bridge/` forwards directly to the
conversation tunnel, add a more specific `/bridge/control/` location pointing
to `http://127.0.0.1:19078/control/`. The general business upstream must remain
unchanged. This preserves `/control/v1/...` at the relay and makes the control
route independent of the business tunnel. Back up the owning server config,
run `nginx -t`, and reload Nginx before testing public management access.
Updating only the relay code cannot change an existing direct Bridge route.

The deployment script generates the ignored `ControlConfig.ets` from the
normalized checkout path's SHA256, matching the Node entrypoint. Keep the
checkout path stable or rebuild the paired phone app after moving it.

Repair progress appears only during a repair near the conversation input and
remains available in settings afterward. Background approval polling errors
do not create a permanent red panel. Real approvals, questions, explicit wait
states and failed submissions continue to expose their action controls.
