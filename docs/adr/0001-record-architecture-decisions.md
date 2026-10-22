# ADR 0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

This project is developed with AI assistance. An AI agent (or a new contributor) reading the code
has no access to the conversations where decisions were made. Without a written record, deliberate
choices look like arbitrary ones, and get silently undone in the next refactor.

## Decision

We record significant architecture decisions as ADRs in `docs/adr/`, numbered sequentially. Each
captures the context, the decision, and the consequences. AGENTS.md instructs agents not to change
architecture without adding one.

## Consequences

- Decisions are durable and discoverable; the reasoning survives past the chat that produced it.
- There's a small overhead per decision. Worth it for anything an agent might otherwise reverse.
- Superseded decisions stay in the log with status `Superseded by ADR XXXX`, not deleted.

---

## Template (copy for new ADRs)

```
# ADR NNNN: <short title>

- **Status:** Proposed | Accepted | Superseded by ADR XXXX
- **Date:** YYYY-MM-DD

## Context
What forces are at play? What problem or constraint prompted this?

## Decision
What we decided, stated plainly.
For Proposed ADRs, describe the option under consideration, not a final decision.

## Consequences
What this makes easier, harder, or rules out. Include the trade-offs you accepted.
```

> **Note on `Proposed` status:** ADRs are not just for decisions already made. A `Proposed` ADR is
> the right place to capture full context for a feature under consideration — before the decision
> is taken. Link to it from `docs/ROADMAP.md`. When the decision is made, flip the status to
> `Accepted` (or `Rejected`, with a note on why) and update the ROADMAP entry accordingly.
