---
name: rovloom
description: Use Rovloom's MCP tools (machines_list, providers_list, runtime_discover, runtime_describe, runtime_call, runtime_call_get, runtime_result_read and friends) to work with Luvus and Herdr sessions on remote machines — list devices and providers, discover native methods, call them, wait, read results, and discard payloads. Use whenever the user mentions Rovloom, a Gateway, an MCP endpoint, remote workspaces/tabs/panes, remote Agent sessions (Claude Code, Codex, Pi, OpenCode, Fx), or wants an AI client to drive terminals and Agents on another machine.
---

# Using Rovloom over MCP

Rovloom funnels Luvus and Herdr sessions from many machines into one MCP endpoint. You talk only to the Gateway; the Gateway reaches each machine's real runtime through a Connector. **Nothing is implicit**: every call names a device, a provider and a profile, and session profiles also name the session.

## When to use this

- The user asks to list their machines, devices, providers, workspaces or Agents.
- You need to read or write a terminal on a remote machine, create or switch workspaces/tabs/panes, or send an Agent a message and read its reply.
- You are diagnosing why a device is unreachable or a provider is not ready.

Do not use MCP for management actions. Device registration, rename, revoke, provider enable/disable, and Bearer issue/rotate live in the management page or in `rovloom admin` / `rovloom token`. MCP also offers no streaming, no Host-privileged shortcut, and no `luvus_*` aliases.

## Prerequisites

| Item | Value |
|---|---|
| Endpoint | Streamable HTTP, fixed path `/mcp`, default `http://127.0.0.1:9444/mcp` |
| Auth | Every HTTP request carries `Authorization: Bearer <TOKEN>`, matched exactly against the principal bound to the session |
| Protocol | MCP 2025-11-25 via the official SDK's Streamable HTTP. **Not stdio**, and no legacy HTTP+SSE |

The Bearer comes from `rovloom token create/renew/rotate` or from the first pairing output, and expires after 30 days by default. A pairing code and the administrator password are **not** Bearers. Never put a password, Bearer or pairing code into a URL, a log, or a file.

If your client prefixes tool names with the server name (OpenCode shows `rovloom_machines_list`), the real wire name is still `machines_list`.

## The 11 tools

| Tool | Purpose | Read-only |
|---|---|---|
| `machines_list` | List devices visible to this caller; each item carries `targets` | yes |
| `machines_get` | Read one device by `machine_id` or exact `name` | yes |
| `providers_list` | List providers under a device (`kind`, `binding_revision`, `readiness`) | yes |
| `providers_get` | Read one provider | yes |
| `runtime_discover` | Discover the methods and `contract_ref` valid for an explicit target and revision | yes |
| `runtime_describe` | Describe one method's native parameters, categories and limits | yes |
| `runtime_call` | Submit one native call | no |
| `runtime_call_get` | Read a call's state and result handle | yes |
| `runtime_call_cancel` | Request stopping the wait or the bridge | no |
| `runtime_result_read` | Read the retained response payload page by page | yes |
| `runtime_response_discard` | Discard the retained response payload | no |

Parameter shapes, returned fields, limits and error codes are in [references/tools.md](references/tools.md). The read-only tools (`machines_*`, `providers_*`, `runtime_discover`, `runtime_describe`, `runtime_call_get`, `runtime_result_read`) are safe to repeat; `runtime_call`, `runtime_call_cancel` and `runtime_response_discard` are not — see the rules below.

## Standard call sequence

Follow this order. Each step's output feeds the next; do not skip steps and do not assemble a target yourself.

**1. Find devices and authorized targets**

```
machines_list {}
```

Returns `items: [{ machine_id, name, status, link, targets }]`. `targets` holds the complete tuples you are **already authorized** for on that device, for example:

```json
{ "machine_id": "m_1", "provider_id": "p_1", "profile": "session", "session": "main" }
```

Keep that object verbatim. `runtime_*` visibility compares the complete tuple for equality, so changing any field — including `session` — yields `not_found`.

**2. Read the provider's current revision**

```
providers_list { "machine_id": "m_1" }
```

Take `binding_revision` (an integer) and `readiness`. `readiness` is `ready` only when the Gateway actually observed that revision dispatch-ready; `unverified` means no trustworthy evidence, not "broken", and the call may still succeed.

**3. Discover methods**

```
runtime_discover {
  "target": { ...the tuple from step 1, verbatim... },
  "expected_binding_revision": 1,
  "limit": 100
}
```

Follow `next_cursor` until the field is absent. Each entry carries `method` and `contract_ref` (64 hex characters of a SHA-256). Discovery describes capabilities; it **grants no execution permission**.

**4. Describe the exact method**

```
runtime_describe {
  "target": { ... },
  "expected_binding_revision": 1,
  "method": "pane.list"
}
```

Read the actual coverage and description fields before filling `params`:

- `params_schema`, when present, is the native parameter schema with its local `$defs` reference closure. Follow its constraints and annotations.
- Luvus `schema_annotations` exposes native request/response document `$comment` and `description`, with `document_uri` and JSON Pointer. Document-root notes describe the document; they are not necessarily specific to this method.
- `schema_status: "generic_params_only"` means there is no native per-method parameter schema. Use available `parameter_help` and the [runtime reference](references/runtimes.md); do not invent a complete schema or reuse another provider's field names. `parameter_help.source: "rovloom_reviewed_subset"` identifies Rovloom's reviewed guide, not native schema coverage.

`terminal_execution` still describes the local gate. Description grants no execution permission. These detailed schemas, notes and examples belong to `runtime_describe`; `runtime_discover` remains a summary list.

**5. Submit the call — exactly once**

```
runtime_call {
  "target": { ... },
  "expected_binding_revision": 1,
  "contract_ref": "<contract_ref from step 3 or 4>",
  "native_request": { "method": "pane.list", "params": {} },
  "deadline": 1765000000000,
  "wait_ms": 500
}
```

- `deadline` is an **absolute Unix millisecond timestamp in the future**, no more than 10 minutes out at registration time. `Date.now() + 60_000` suits short operations; for a longer native wait, allow its duration plus RPC overhead (for example, 150 seconds for a 120-second wait).
- `wait_ms` only bounds this HTTP request's short wait: 0–5000, default 0. It is independent of the execution deadline.
- Luvus RPC defaults to a local cap of 10 minutes, bounded by the original call deadline and any explicit shorter local limit. Endpoint discovery and schema reading still have a 30-second preparation budget. Poll the original call for long waits; increasing `wait_ms` does not extend execution.
- `client_request_key` is optional and deduplicates within one principal. Re-sending the same intent **must** reuse the original key.

**6. Query and read the result**

For a Luvus output sentinel, discover `wait.output` on the exact target, describe it, and call it with `{ "pane": "<observed pane ID>", "match": "<literal marker>", "timeout_s": 35 }`. Approved targets and read/dispatch/cancel actions apply uniformly to every exposed method; read-only access does not grant dispatch. Do not edit caller/local/raw method lists. New pairing stores no method snapshot and old lists are ignored. Allow RPC overhead before the call deadline and poll the original call. Historical output and prompt echo can match, so verify the actual reply. If discovery omits the method, the current provider does not expose it; continue reading state/output.

```
runtime_call_get { "call_id": "<call_id from step 5>", "wait_ms": 2000 }
```

Poll until `state` is `responded`, `not_dispatched` or `outcome_unknown`. Then:

```
runtime_result_read { "result_id": "<view.result.result_id>", "max_bytes": 16384 }
```

Follow `next_cursor` until `eof: true`. Decode `chunk` according to `encoding` (currently always `base64`); when this page's bytes are valid UTF-8 you also get `text`. After concatenating every page, verify `sha256` and `total_bytes`.

## Rules you must follow

These are not style advice. Violating them loses data or repeats side effects.

1. **Never resend automatically.** `outcome_unknown` means the native side may have executed with no receipt. Resending can duplicate side effects (creating a workspace, sending a prompt, running a command). Report it faithfully and let the user decide.
2. **A `wait_ms` timeout is not a failure.** It only means this short wait ended; `call_id` is still valid. Keep querying the original call with `runtime_call_get`.
3. **`contract_ref` and `binding_revision` do not transfer across providers.** A revision mismatch returns `binding_revision_conflict`; a stale contract on a new call returns `contract_unavailable` before registration. Refresh `providers_get` and `runtime_discover/describe` after upgrades or either mismatch. An existing request key still refers to its original call; changing its contract is a different intent and returns `conflict`. Never resend an existing unknown call with a fresh key just to use a newer contract.
4. **Never guess a session name.** `providers_list` returns neither `profile` nor `session`; only `targets` on `machines_*` has them. Without an authorized tuple, do not construct a target.
5. **Use the current provider contract.** Method names do not form a token ACL. Approved targets and read/dispatch/cancel actions remain in force; read-only access never becomes dispatch access. Device scope, provider availability, native parameters and device operating settings still apply. Missing Gateway caller binding fails closed. Do not invent an unexposed method or resend an unknown call.
6. **Result handles expire.** A `runtime_result_read` cursor is bound to the caller, result, page size and deadline; paging and retries never extend it. After expiry, call `runtime_call_get` again for a fresh handle (content still obeys the original deadline).
7. **Do not manage devices over MCP.** You also cannot supply a principal, admin, `discard_response`, or a native `id` or `auth` through parameters; the schema rejects them.
8. **Terminal input is off by default.** A device's `allow_terminal_execution` defaults to `false`. With it off, `agent.prompt` / `agent.send` must carry an explicit `strict: true`, and `agent.keys` plus custom launch arguments are refused outright. The device owner configures that switch locally; you cannot turn it on remotely.

## Error codes and what to do

A Gateway refusal returns `isError: true` with `gateway_error: { code }`.

| Code | Meaning | Action |
|---|---|---|
| `unauthenticated` | Bearer missing, invalid or expired | Ask the user to renew or reissue; do not retry the same token |
| `forbidden` | Approved target/action boundaries, device scope, native permissions or a device operating setting rejects the request; MCP has no per-method token ACL | Report the refusal and check the device/provider state; do not edit method lists or hunt for another target |
| `not_found` | The target tuple is outside your visible devices, the method is not exposed, or the object is gone | Re-run `machines_list` and `runtime_discover`; do not fuzzy-match |
| `binding_revision_conflict` | The revision changed | Re-run `providers_get` and `runtime_discover` |
| `unavailable` / `backend_unavailable` | Device offline or backend unavailable | Check `link` from `machines_get`; do not hammer it |
| `contract_unavailable` | Native contract, capabilities or policy changed mid-read | Re-run discover and describe |
| `native_request_invalid` | Native schema or reviewed parameter checks rejected the request before registration; **definitely not dispatched** | Read optional `details.issues` / `details.parameter_help` and `runtime_describe`, correct the parameters, then resubmit |
| `invalid_arguments` | MCP parameter shape is wrong | Fix against the schema |
| `conflict` | One `client_request_key` used for a different intent | Use a new key for the new intent; keep the old key for the same intent |
| `invalid_cursor` | Cursor expired, was tampered with, or is reused across queries | Restart from the first page |
| `content_unavailable` | Result handle unusable, payload expired or discarded | Call `runtime_call_get` again |
| `storage_exhausted` / `storage_degraded` | Result quota or storage degraded | Escalate to the user; do not keep reading |
| `deadline_exceeded` | The `deadline` passed before registration | Register again with a new future deadline (only if truly not dispatched) |
| `busy` | More than 16 concurrent tool requests in this session | Lower concurrency and retry |
| `unsupported` | This provider or method does not support it | Stop and report the capability gap |
| `confirmation_required` | The user must confirm | Hand the confirmation request to the user verbatim |

`native_request_invalid` additionally carries `outcome: "not_dispatched"` — that is the **only** refusal that confirms "nothing ran, safe to fix the parameters and resubmit".
For supported Luvus methods, `gateway_error.details.issues` contains fixed field paths and rules such as `/params/pane` with `required`, or `/params/wait` with `required_true`. When the reviewed diagnostics cannot safely locate the rejected parameter, `/params` with `invalid_value` indicates a general parameter rejection; it does not identify a specific field. The details omit user values and raw native error text; they are not a complete list of every possible parameter error.

## Recipes

### Device and native version information

Use `machines_list.platform` for a short OS/architecture summary and `machines_get` for optional `host`, `last_seen_at` and `link_since`. Host data is reported at connection time: always retain `reported_at` and `source:"connector_handshake"`; it is not live probing. Old Connectors omit host, and unknown times are null. Host/timing history is process-local and bounded, so restart or eviction can remove it. CPU/memory describe the OS-visible resources, not container quotas. Provider list/get expose `native_version`, `schema_status` (`validated` / `unavailable`) and `schema_sha256` from an authorized contract; provider-level schema verification is not complete per-method parameter coverage or proof of current runtime readiness. Do not run shell commands in a pane to fabricate these fields.

Luvus `host.info` / `host.capabilities` are native host-profile methods, not session methods. They have reviewed read-only classification, but the independent host stdio execution route is not yet available (tracking [#303](https://github.com/ArnoChenFx/rovloom/issues/303)). Do not send them to a session target or describe them as usable `runtime_call` methods until that route is implemented and explicitly authorized.

### Listing panes (Luvus)

```json
{ "method": "session.snapshot", "params": {} }
{ "method": "pane.list", "params": {} }
```

`pane.list` takes **no** workspace selector, only the optional `all_tabs` (default `true`). To narrow to one workspace, `workspace.focus` first or read the hierarchy from `session.snapshot`. `pane.get` takes a `pane` argument and its result gives you `workspace_id` / `tab_id`.

Most Luvus methods (such as `workspace.list` and `pane.list`) have the validation mode chosen for you by the Gateway, so you never fill in `validation`. The `strict` group is `pane.list`, `agent.prompt`, `agent.send`, `agent.wait` and `agent.keys` — still chosen for you.

Luvus `agent.start` requires `name` and `kind`, both matching `^[a-z][a-z0-9_-]{0,31}$`. `pane` is optional: omit it to create a new pane, or supply an observed pane to use it; optional `anchor` selects a split anchor and cannot be combined with `pane`. Use the returned pane ID for later calls. Invalid names receive `/params/name` with rule `pattern` in `gateway_error.details.issues`; read `runtime_describe.parameter_help` for the full reviewed guide.

### Reading a terminal

```json
{ "method": "pane.read", "params": { "pane": "<pane_id>", "lines": 200 } }
```

`lines` caps at 1000 and returns only the trailing lines. What you get back is a **rendered screen** that may be truncated — not lossless stdout.

### Getting an Agent to reply

1. `agent.list` / `agent.get` to find the Agent and pane actually observed.
2. `agent.prompt` (Luvus) with `target`, `text`, the observed `terminal_id`, and `strict: true`. Prefer omitting `wait`, `until` and `timeout_s`; obtain the submission result through the original call.
3. Poll `agent.read` / `pane.status` with short calls for the real reply. Check the same terminal and session; status or output changes alone do not prove this turn completed. `submitted`, `queued` and `ready=true` **do not mean the model answered**.

For Luvus, `agent.prompt` selects an Agent **`target`**; `agent.wait` selects a **`pane`**. A blocking prompt uses `wait:true`, `until:["idle"]` and `timeout_s`; `until` or `timeout_s` without `wait:true` is invalid. Prompt waiting first requires a new working/blocked transition before matching `until`. In contrast, `agent.wait` matches the current state, uses exactly one of `status` or `statuses`, and has no `wait` flag. Multiple states mean **any** listed state, not a sequence. Read the native notes before interpreting an immediate idle match as a reply.

For fast tasks, use `agent.prompt` without waiting → `agent.wait` on the resolved pane with `statuses:["done","idle"]` → `agent.read` on the same Agent, and verify the actual reply against this turn. An old idle/done state can match immediately. One-step `wait:true` can still time out without a new transition even if its reported `status:"done"` is in `until`; the transport fix does not change this native behavior.

`evidence:"timeout"` with explicit `observed_state:null` means no qualifying transition was observed; with `observed_state:"working"` or `"blocked"` it means the wait did not match before its deadline. Neither proves the Agent failed to reply; a fast answer can already be visible in `agent.read`. Missing `observed_state` in an older response is not explicit null. Treat `state_source:"no_positive_state_evidence"` as unknown even when status says idle; do not turn it into success or resend a submitted prompt. Use output sentinels only if `wait.output` is listed in the current discovery; otherwise keep reading state/output. Recent text and prompt echo can match, so verify the actual reply separately.

A two-turn conversation must keep the same complete target, the same pane or alias, the same `terminal_id`, and the known Agent `session`. When checking turn two, verify it recalls turn one's content; terminal echo is not a reply.

### Submitting a terminal command (Luvus)

`pane.run` accepts `pane` and `command`; it accepts no `cwd`, `env` or `argv` override. Its `{"type":"ok"}` acknowledges input submission. Read output with `pane.read`; the acknowledgement contains no command stdout, stderr or exit status and does not prove completion.

### Herdr

Herdr methods use `strict` validation and differ from Luvus in both method and parameter names (`pane.send_text`, `workspace.create`, `ping`). Trust the schema from `runtime_describe`; do not reuse Luvus parameter names.

## When there is no MCP client library

If the host only has a shell, use the bundled dependency-free script (plain `fetch`):

```sh
export ROVLOOM_MCP_URL='http://127.0.0.1:9444/mcp'
export ROVLOOM_MCP_TOKEN='<bearer>'

node skills/rovloom/scripts/mcp-call.mjs tools
node skills/rovloom/scripts/mcp-call.mjs call machines_list '{}'
node skills/rovloom/scripts/mcp-call.mjs call providers_list '{"machine_id":"m_1"}'
node skills/rovloom/scripts/mcp-call.mjs call runtime_call '{"target":{...},"expected_binding_revision":1,"contract_ref":"<sha256>","native_request":{"method":"ping","params":{}},"deadline":1765000000000,"wait_ms":2000}'
node skills/rovloom/scripts/mcp-call.mjs read '<result_id>'
```

The script performs `initialize` → `notifications/initialized` → call → `DELETE` the session itself, aggregates `tools/list` pages, and on `read` follows cursors and verifies `sha256` and `total_bytes`. The Bearer is read from the environment only, never from the command line.

## Going deeper

- [references/tools.md](references/tools.md): full parameters, returned fields, limits and cursor rules for all 11 tools.
- [references/runtimes.md](references/runtimes.md): the Luvus method families, selectors, coordinate traps and `if_revision`; Herdr contrast; what the terminal-execution switch covers.
- In-repo authorities: `docs/protocol/MCP-HTTP.md`, `docs/LUVUS-OPERATIONS.md`, `docs/TERMINAL-EXECUTION.md`. The authoritative parameter definition is `src/mcp/schema.ts`.
