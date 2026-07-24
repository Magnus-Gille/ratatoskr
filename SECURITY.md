# Security Policy

## Supported versions

Security fixes are expected on the current `main` branch.

## Reporting a vulnerability

Please do not open a public GitHub issue for vulnerabilities involving:

- authentication or authorization
- token or secret handling
- data disclosure
- remote code execution or privilege escalation

Prefer private disclosure to the maintainer first. If GitHub private vulnerability
reporting is enabled for the repository, use that. Otherwise, contact the maintainer
through a private channel before public disclosure.

Include:

- affected version or commit
- impact summary
- reproduction steps
- any required configuration assumptions

## Scope notes

Ratatoskr is designed for self-hosted, single-operator deployments on a private
tailnet. It is not hardened for public internet exposure: the HTTP API is intended
to bind only to loopback or a Tailscale address, and Telegram access is restricted
to an explicit user allowlist. Deployments that deviate from those assumptions do
so at their own risk.
