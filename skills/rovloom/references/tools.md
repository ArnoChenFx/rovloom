# Tool reference

The authoritative definition is `src/mcp/schema.ts` in the repository; this is a caller-facing summary. Every parameter object rejects unknown fields at its root, and a wrong shape returns `invalid_arguments` (or `Invalid tool arguments` at the JSON-RPC layer).

## Shared shapes

### Target

```json
{ "machine_id": "m_1", "provider_id": "p_1", "profile": "session", "session": "main" }
```

or the host form:

```json
{ "machine_id": "m_1", "provider_id": "p_1", "profile": "host" }
```

The host form **must not** carry `session`; the session form **must**. `runtime_discover`, `runtime_describe` and `runtime_call` all require `target` plus `expected_binding_revision`.

### Identifiers

- `machine_id`, `provider_id`, `call_id`, `result_id`, `client_request_key`: `^[a-zA-Z0-9_-]{1,128}$`
- `text` values (such as `name` and `method`): 1–256 characters and must contain a non-whitespace character
- `contract_ref`: `^[a-f0-9]{64}$`
- `expected_binding_revision`, `deadline`: safe integers, ≥ 1

### Reply envelope

Success: `structuredContent: { data: ... }` plus a JSON text copy with the same content (`content[0].text`).
Refusal: `isError: true` with `structuredContent: { gateway_error: { code, outcome? } }`.
Over budget: `{ gateway_error: { code: "response_too_large" }, delivery: { truncated: true, bytes, sha256, call_id? } }`.

## 1. machines_list

Parameters: `cursor?`, `limit?` (1–100).

Returns `{ items: MachineView[], next_cursor? }`:

| Field | Meaning |
|---|---|
| `machine_id` | Stable ID |
| `name` | Name set by an administrator |
| `status` | `pending` / `active` / `revoked` |
| `link` | `connected` (trustworthy online evidence in the same sample) / `unverified` (no evidence; never inferred as offline) / `offline` (`pending` and `revoked` always report this) |
| `targets` | The complete tuples you are authorized for on this device; usable verbatim as `runtime_*`'s `target` |

`link` comes from the Gateway's observation of real transport, not from persisted state. `unverified` does not mean the device is broken.

## 2. machines_get

Parameters: `machine_id` **or** `name` (exactly one, exact match). Returns a single `MachineView`.

## 3. providers_list

Parameters: `machine_id` (required), `cursor?`, `limit?`.

Returns `{ items: ProviderView[], next_cursor? }`:

| Field | Meaning |
|---|---|
| `machine_id` / `provider_id` | Stable IDs |
| `kind` | `luvus` / `herdr` |
| `binding_revision` | Current binding version; use as `expected_binding_revision` |
| `enabled` | Whether an administrator enabled it |
| `readiness` | `ready` (observed revision matches the current binding and dispatch is ready) / `unavailable` (disabled) / `unverified` (no evidence or stale observation) |

`providers_list` returns neither `profile` nor `session` — those appear only in `targets` on `machines_*`.

## 4. providers_get

Parameters: `machine_id`, `provider_id`. Returns a single `ProviderView`.

## 5. runtime_discover

Parameters: `target`, `expected_binding_revision`, `cursor?`, `limit?`.

Returns `{ items: MethodEntry[], next_cursor? }`. Each entry carries:

- `method`: the native method name
- `contract_ref`: digest of the contract this discovery belongs to; `runtime_call` must use the same value
- `profile`, `transport` (`single_request_rpc` / `host_stdio_proxy` / `unclassified`)
- `schema_status` (`conditional_branch` / `generic_params_only` / `unavailable`), `branch_paths`
- `classification_status`: always `not_evaluated`
- `native_contract`: native method metadata
- `terminal_execution?`: `{ local_state: "enabled"|"disabled"|"unknown", request_parameters_checked?, requires_explicit_strict? }`

The catalog contains only methods you are currently authorized for **and** that the terminal switch allows to be visible. Discovery is not execution permission.

## 6. runtime_describe

Parameters: `target`, `expected_binding_revision`, `method`.

Returns that method's native description (parameter schema, categories, limits) plus `method`, `contract_ref` and `terminal_execution`. A method outside the current authorized catalog returns `not_found`.

Fill `params` from the described schema. Luvus and Herdr often use different parameter names for the same idea.

## 7. runtime_call

Parameters:

| Parameter | Required | Meaning |
|---|---|---|
| `target` | yes | The complete tuple |
| `expected_binding_revision` | yes | From `providers_get` |
| `contract_ref` | yes | From `runtime_discover` / `runtime_describe` |
| `native_request` | yes | `{ method, params? }` |
| `deadline` | yes | Absolute future Unix milliseconds; at registration it must be in the future and no more than 10 minutes out |
| `wait_ms` | no | 0–5000, default 0; only bounds this HTTP short wait |
| `validation` | no | `strict` / `raw-contract` |
| `client_request_key` | no | Deduplication key within one principal |

When `validation` is omitted the Gateway picks per provider and method:

- Herdr: `strict`
- Luvus `pane.list`, `agent.prompt`, `agent.send`, `agent.wait`, `agent.keys`: `strict`
- Other reviewed Luvus methods (such as `workspace.list`): `raw-contract`

Explicitly supplying a mode the method does not accept is refused before registration as `native_request_invalid`. Unless you have a reason, **do not fill in `validation`** yourself.

`client_request_key` deduplicates over `metadata_ttl`. The same key with the same intent returns the original `call_id`; the same key with a different intent returns `conflict`. The Gateway neither generates nor replaces keys, so idempotent retries must reuse the original.

Returns a `CallView`:

| Field | Meaning |
|---|---|
| `call_id` | Call handle; used for later query, cancel and discard |
| `target` | The target actually registered |
| `provider_kind` | `luvus` / `herdr` |
| `binding_revision` | Revision at registration |
| `contract_ref` | Contract digest at registration |
| `state` | `created` / `dispatching` / `connector_accepted` / `responded` / `not_dispatched` / `outcome_unknown` |
| `delivery` | `not_dispatched` / `responded` / `possibly_dispatched` |
| `content_status` | `available` / `expired` (past the content deadline) / `discarded` (explicitly discarded) / `unavailable` (for example the device was deleted) |
| `content_delivery` | `result_handle` when a payload is readable, otherwise `unavailable` |
| `content_expires_at` | Payload deadline |
| `content_reason_code?` | Why the payload is unreadable |
| `result?` | `{ result_id, bytes, sha256, expires_at }`, present only when `responded` and the payload is available |

The metadata returned by `runtime_call` does **not** flag native errors — native errors live inside the payload.

## 8. runtime_call_get

Parameters: `call_id`, `wait_ms?` (0–5000). Returns the same `CallView`.

`wait_ms` only bounds this short wait; it does not affect the execution deadline. Stop polling once `state` is `responded`, `not_dispatched` or `outcome_unknown`.

## 9. runtime_call_cancel

Parameters: `call_id`. Returns `{ call_id, cancellation }`:

| Value | Meaning |
|---|---|
| `waiting_stopped` | Only the front-end wait was stopped; nothing was dispatched |
| `unsupported` | Already dispatched, with no confirmable cancel channel |
| `outcome_unknown` | Outcome unknown; a cancel cannot prove rollback |

Do not treat this as "execution cancelled". Cancelling promises no native rollback and does not imply the call can be resent.

## 10. runtime_result_read

Parameters: `result_id`, `cursor?`, `max_bytes?` (1–16384, default 4096).

Returns:

| Field | Meaning |
|---|---|
| `result_id` | Echoed back |
| `chunk` | base64 bytes |
| `encoding` | Currently always `base64`; decode according to this field rather than hardcoding |
| `text?` | Present when this page's bytes are valid UTF-8, byte-for-byte identical to decoding `chunk`; omitted when a page boundary splits a multi-byte character or the page exceeds the budget |
| `next_cursor?` | Cursor for the next page |
| `eof` | Whether this is the last page |
| `total_bytes` | Byte count of the whole result |
| `sha256` | Digest of the whole result (not of this page) |
| `expires_at` | Handle deadline |

The cursor is bound to the caller, `result_id`, `max_bytes`, offset and deadline. The first successor's deadline is the earlier of "now + 30 seconds" and the handle's actual deadline; every later successor keeps that or an earlier handle deadline — **paging and retries never extend it**. An expired, tampered, cross-caller/cross-result/cross-page-size cursor, a changed query, or a cursor from before a service restart returns `invalid_cursor`. Re-reading with the same valid cursor returns the same page.

Verify `sha256` and `total_bytes` after concatenating every page; otherwise report the result as incomplete instead of guessing at the content.

## 11. runtime_response_discard

Parameters: `call_id`. Returns `{ call_id, content_status: "discarded" }`.

A standalone action: it requires ownership, the method's current read policy, and a dedicated `discard_response` permission. Callers cannot declare `discard_response` in parameters.

## Transport and limits

| Item | Limit |
|---|---|
| Endpoint | `POST/GET/DELETE /mcp`; no query, userinfo or other path |
| Request body | 1 MiB (checked before JSON parsing, under the deadline) |
| Total request headers | 16 KiB |
| Single tool's arguments | 64 KiB |
| Complete JSON-RPC response | 64 KiB |
| String request ID | 128 bytes; at most 1024 protocol correlations |
| `tools/list` | 5 items per page, using the standard `nextCursor` |
| MCP sessions | 64 by default, reclaimed after 15 idle minutes |
| Concurrent HTTP requests | 256, beyond which 429 |
| Per-request deadline | 35 seconds (host cap 60 seconds) |
| Concurrent tool requests per session | 16, beyond which `busy` |

- Duplicate JSON keys, invalid or truncated UTF-8, over-deep nodes and batched JSON-RPC are all rejected.
- Resubmitting the same request ID while it is in flight returns 409.
- There is no event store: no event replay is promised after a disconnect.
- Request cancellation, an HTTP disconnect, and session `DELETE` only stop the front-end wait. They **do not** call `runtime_call_cancel`, and they do not mean `not_dispatched` or "safe to resend".

## Paging

Cursors for `machines_list`, `providers_list` and `runtime_discover` are generated by the service, signed with a private HMAC-SHA256 key, and bound to the caller, query, position, current authorization and deadline, without consuming server-side slots. A cursor is not authorization: every page re-verifies the current identity and grants. Using an old cursor across callers, after a query change, or after a service restart returns `invalid_cursor`.

## Semantic boundaries

- Every list, count and description is filtered by the caller's grants.
- No streaming, no Host-privileged shortcut, no provider management, no `luvus_*` aliases.
- Callers cannot submit a principal, admin, `discard_response`, or a native `id` or `auth` inside `native_request`.
- Device registration/rename/revoke, provider enable/disable, and token management happen only in the management listener and the CLI, never over MCP.
