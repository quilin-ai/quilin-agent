# soul.md Frontmatter Schema

`soul.md` is the project-level agent identity file. M2.6 freezes the schema
and adds a read-only validator only; M2.7 static loading and any write path are
out of scope for this round.

## Location

Default project path:

```text
.quilin/soul.md
```

The file uses YAML frontmatter followed by free Markdown body text.

## Frozen Frontmatter Fields

| Field | Required | Type | Notes |
|---|---:|---|---|
| `schema_version` | yes | integer | Must be `1`. |
| `persona_name` | yes | string | Stable agent persona name. |
| `core_values` | yes | string array | Long-lived principles. |
| `communication_style` | yes | string | Stable interaction style summary. |
| `created_at` | yes | ISO timestamp | Creation time. |
| `last_updated_by` | yes | string | `human`, `migration`, or future approved actor. |

The Markdown body is intentionally free form and may describe persona
boundaries, product voice, and long-term operating principles.

## Change Control

Schema changes must go through an ADR. This M2.6 implementation validates the
schema but does not load it into runtime context and does not implement any
agent-initiated write path. Future self-evolution writes must be proposed as
patches and reviewed through the WriteAuthority boundary described in
[Safety Guardrails](../07-safety-guardrails/README.md).
