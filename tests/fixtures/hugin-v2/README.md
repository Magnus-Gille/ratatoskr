# Hugin v2 task-signing compatibility fixture

These files are exact byte copies of the pinned Hugin v2 candidate supplied for
the Ratatoskr migration. The compatibility test fails closed if either file is
missing or its SHA-256 changes; it never falls back to a sibling checkout or a
silent skip.

- `task-signing.ts` — verifier fixture, SHA-256
  `0b9d34cdc51170d9ac3cbb3e0b623aff53b8a4272000604294169a33e068e569`
- `sign-task.mjs` — producer helper, SHA-256
  `5381ff34886757267cfee91ba8baa15a52d34b814239deedb17ed71b6c13183c`

Source: Hugin local candidate `5a055936d23ea5d8695e8ccd062a5cfc7776b17d`,
paths `src/task-signing.ts` and `scripts/sign-task.mjs`. Root verified the
verifier against that candidate; both supplied fixture bytes are hash-pinned.
The fixture contains no credentials or real task data.
