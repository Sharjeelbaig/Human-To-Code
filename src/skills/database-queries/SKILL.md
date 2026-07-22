---
name: database-queries
description: Generate correct local database and ORM operations. Use for SQL, queries, repositories, models, records, joins, filters, indexes, transactions, persistence, migrations, or database connections.
---

# Database Queries

- Use the evidenced database/ORM dialect, model names, columns, relationships, placeholders, and transaction API.
- Parameterize values; never concatenate untrusted input into query text.
- Preserve null, missing-row, uniqueness, ordering, pagination, and duplicate semantics.
- Select only fields needed by the established return contract when practical.
- Make multi-step writes atomic when partial completion would violate an invariant.
- Avoid N+1 access and unbounded reads when surrounding APIs provide batching, joins, limits, or streaming.
- Do not invent schema columns, tables, migrations, cascade behavior, or indexes from a query-local instruction.

Treat the existing schema and repository contracts as authoritative.
