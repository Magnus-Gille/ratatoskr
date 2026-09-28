# Ratatoskr docs index

This is the complete reference-doc index for Ratatoskr. Behavioral rules,
deployment invariants, and safety constraints stay inline in `AGENTS.md`; use
these docs for lookup material.

## System reference

- `architecture.md` — runtime overview, request flow, and the detailed
  source/component map for Telegram handling, concierge triage, Munin/Hugin
  task flow, reminders, alerts, transcription, document storage, health, and
  recovery.
- `environment.md` — the full runtime configuration table for
  `TELEGRAM_*`, `MUNIN_*`, `CONCIERGE_MODEL`, `LLM_*`, `RATATOSKR_*`, and
  `HEIMDALL_*`.

## Operations

- `remote-send.md` — authenticated remote `/api/send` over Tailscale and the
  `scripts/ratatoskr send` operational path.
- `reminders.md` — reminder API usage plus persistence, delivery, and crash
  semantics.

## Validation evidence

- `alert-consumer-evidence-2026-07-26.md` — bounded production receipt/readback
  evidence for Ratatoskr's Heimdall firing/resolution lifecycle.
