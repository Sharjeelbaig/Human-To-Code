---
name: api-contracts
description: Preserve local HTTP, RPC, GraphQL, event, webhook, and SDK contracts. Use for routes, endpoints, handlers, requests, responses, status codes, headers, pagination, serializers, clients, schemas, or public API methods.
---

# API Contracts

- Preserve evidenced method, route, parameter location, field name, casing, status, header, and response envelope.
- Validate untrusted input at the boundary before domain work; distinguish missing, malformed, unauthorized, not-found, conflict, and internal failures according to existing conventions.
- Serialize only the established public shape. Do not leak internal models, secrets, stack traces, or extra fields.
- Maintain sync/async and streaming semantics, pagination tokens, idempotency behavior, and content type.
- Keep client and server names/signatures aligned with supplied contracts.
- Do not introduce a new API version, authentication scheme, endpoint, or compatibility break from a local instruction.

The surrounding API is authoritative; implement only the target’s part of it.
