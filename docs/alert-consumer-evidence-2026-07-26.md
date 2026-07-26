# Ratatoskr → Heimdall alert lifecycle evidence

This is the bounded production receipt/readback record for Ratatoskr issue #57.
The probe used the authenticated consumer ingest and the consumer's read-only
active-alert view. Its synthetic identity was generated at runtime and the
firing alert was immediately resolved.

## Result

| Metadata | Result |
|---|---:|
| Observed at (UTC) | `2026-07-26T04:34:04.137Z` |
| Matching active count before firing | `0` |
| Firing HTTP status | `200` |
| Firing accepted | `true` |
| Matching active count after firing | `1` |
| Resolution HTTP status | `200` |
| Rows resolved | `1` |
| Matching active count after resolution | `0` |
| Lifecycle result | `pass` |

No credential, endpoint, URL, host, private locator, alert identity, title, body,
link, or other alert content is retained in this evidence.
