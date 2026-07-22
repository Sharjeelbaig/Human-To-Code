---
name: sql-local-code
description: Generate local SQL for the evidenced dialect and schema. Use for .sql, SQL, SELECT, INSERT, UPDATE, DELETE, joins, CTEs, transactions, constraints, indexes, procedures, or query fragments.
---

# SQL Local Code

- Follow the detected dialect, placeholder style, identifier casing/quoting, schema names, and migration conventions.
- Reference only evidenced tables, columns, constraints, functions, and relationships.
- Parameterize external values. Never interpolate user-controlled text into executable SQL.
- Make join cardinality, null handling, grouping, duplicate behavior, and ordering explicit where they affect results.
- Add a deterministic `ORDER BY` when pagination or first/last selection requires stable order.
- Scope writes precisely and use transactions when the requested multi-step invariant requires atomicity.
- Do not invent destructive migrations, cascading behavior, columns, or indexes from a query-local marker.

Return only the expression, clause, statement list, procedure body, or file expected at the insertion point.
