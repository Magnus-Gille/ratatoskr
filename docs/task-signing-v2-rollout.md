# Ratatoskr task-signing v2 rollout

Ratatoskr v2 signs the complete final unsigned Hugin task document: task ID,
runtime, context, timeout, submitter, submitted-at, reply-to, and prompt are
all covered by the HMAC-SHA256 payload. The signature is then inserted at the
single metadata slot defined by Hugin. A missing Ratatoskr signing key keeps
the existing unsigned behavior; no key is invented by the producer.

The producer and consumer must be rolled out as a coordinated pair. Before any
release, record the exact 40-character Ratatoskr revision and the exact
40-character Hugin verifier revision in the release receipt. The committed
compatibility fixture under `tests/fixtures/hugin-v2/` is pinned to the supplied
Hugin candidate by SHA-256:

- verifier `task-signing.ts`: `0b9d34cdc51170d9ac3cbb3e0b623aff53b8a4272000604294169a33e068e569`
- helper `sign-task.mjs`: `5381ff34886757267cfee91ba8baa15a52d34b814239deedb17ed71b6c13183c`

The new verifier accepts v2 only: deploying it alone under `require` rejects
tasks from the old v1 producer. Plan a coordinated admission pause. Stop new
producer submissions and dispatcher claims, reconcile running and queued tasks,
and resolve remaining v1 tasks before switching revisions. Do not bulk re-sign
queued task text or infer authority from its claimed submitter. Any authorized
resubmission must preserve deduplication and must not repeat completed work.

While admission remains paused, deploy and verify the exact Hugin revision,
then deploy Ratatoskr and verify an authenticated synthetic task using the
approved verification path. Reopen normal admission only after the matched
pair and queue state pass acceptance.
The signing policy must remain unchanged during this migration: do not weaken,
disable, or bypass consumer verification to accommodate a partial rollout. Do
not rotate, copy, print, or otherwise change real signing keys as part of this
work.

If rollback is needed, keep admission paused, reconcile in-flight and queued v2
tasks, and bind the exact approved prior revisions for both components. Restore
the producer/verifier pair before reopening admission; neither version may
submit work to an incompatible verifier. Restore only the previously approved
code/configuration baseline. Returning to a vulnerable verifier requires the
owner-approved recovery decision; it is not an automatic authentication
downgrade. Key material is outside this procedure.
