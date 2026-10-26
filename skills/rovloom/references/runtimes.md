# Runtime semantics

MCP forwards `method` and `params`; parameters and behavior follow the native contract and Rovloom's reviewed subset. **Describe first and check the reported coverage** — never write field names from memory or infer one provider's parameters from another. This file covers the Luvus and Herdr differences that matter most, plus the traps that make calls fail or mislead.

## Luvus

Corresponds to Luvus 0.14.3. The authoritative method list is `src/runtime/luvus-operations.ts`; the Gateway only lets through methods in its static table.

### Native schema, annotations and reviewed help

`runtime_describe.params_schema`, when present, comes from the same verified installed schema as execution validation. For the ordinary reviewed methods, native branches exist for `pane.list`, `agent.prompt`, `agent.send`, `agent.wait` and `agent.keys`; the returned closure preserves native constraints and annotations. Most other methods, including `agent.start` and `workspace.list`, remain `generic_params_only`. Extra conditions that cannot be accurately projected are not discarded to invent a complete parameter schema.

Read `schema_annotations` as well: each note carries its original `document_uri`, JSON Pointer and text. The native request document's `$comment` explains prompt waiting transitions and current-state matching; document-root notes retain that scope. `parameter_help` for `agent.wait`, `agent.prompt`, `pane.run` and `wait.output` is separately marked `rovloom_reviewed_subset`, with field rules and examples. It supplements native coverage, rather than replacing it. These details appear in describe, not discovery summaries.

### There is no `window.*`

Luvus uses three levels: workspace → tab → pane. Discover those actual methods; there is no `window.*` alias to probe.

### Discovery and selection

| Need | Method |
|---|---|
| Whole-session snapshot | `session.snapshot` |
| Workspace | `workspace.list` / `get` |
| Tab | `tab.list` / `get` (`tab.list` covers only the current workspace) |
| Pane | `pane.list` / `get` / `current` |

`pane.list` accepts only the optional `all_tabs` (boolean, default `true`) and takes **no** workspace or tab selector. To filter by workspace, `workspace.focus` first, or read the hierarchy from `session.snapshot` and then `pane.get` each pane. `pane.get` takes a `pane` argument.

Prefer saving **stable IDs** such as `workspace_id`, `tab_id` and `terminal_id`; do not rely on titles, positions or "the most recent object".

Every reviewed `pane` selector, including `agent.start.anchor`, accepts a canonical decimal string from `"1"` through `"4294967295"` (native positive `u32`). Numbers, leading zeros and larger values are rejected before registration.

The decimal `pane` returned by Luvus 0.14.3 is a process-wide allocated ID, not a layout position. It stays with the pane across splits and moves, so you can reuse it across calls within the same running instance. It is reallocated when the runtime restores panes after a restart; never treat the same number in a new instance as proof of the same terminal.

`pane.list` currently omits `terminal_id`. Once you select a `pane`, call `pane.get({pane})` to obtain its `terminal_id`, `workspace_id` and `tab_id`; `agent.read` also returns `terminal_id`. Keep the complete provider target and terminal identity with the pane ID. A terminal ID is an identity check, not a replacement selector accepted by every pane method. Re-discover after an instance restart or identity mismatch; do not silently choose the current pane.

| Native response | Pane field | Terminal / topology identity |
|---|---|---|
| `session.snapshot` terminal row | `pane_id` | `terminal_id`; workspace/tab are nested, without their stable IDs in 0.14.3 |
| `pane.list` row | `pane` | `workspace_id`, `tab_id`; no `terminal_id` |
| `pane.get` result | `pane` | `terminal_id`, `workspace_id`, `tab_id` |

For a snapshot terminal row, call `pane.get` with `params: {pane: row.pane_id}`; for a list row use `params: {pane: row.pane}`. Do not pass `pane_id` as a replacement request key. Rovloom preserves these native field names. Get is not a strict superset of list: list also has detailed history metrics. `workspace_id` / `tab_id` survive restoration of the saved topology; `terminal_id` survives moves and client reconnects only while the same PTY lives, and changes when the PTY is recreated.

### Coordinate traps (the easiest thing to get wrong)

Luvus uses different position coordinates in different methods, and Rovloom returns them unchanged without conversion:

| Source | Coordinate | How to use it |
|---|---|---|
| `session.snapshot` workspace/tab `index` | **One-based** number, with no stable ID | The `pane_id` of an entry with `kind: "terminal"` is a string usable as `pane.get`'s `pane`; the result gives you `workspace_id` / `tab_id`. Placeholder IDs of `kind: "view"` cannot be used this way |
| `workspace.list/get`, `pane.list/get`, and the `workspace` in Agent rows | **Zero-based** decimal string | Only `workspace_id` in the same row is stable; never pass a snapshot's one-based `index` as `workspace` |
| `tab.list/get` and `pane.list/get`'s `tab` | **One-based** decimal string | Only `tab_id` in the same row is stable |

Position parameters may be a number or a decimal string and are forwarded unchanged; the Gateway does not convert, focus or retry. Re-read the stable ID from the latest `list` or `get` before writing.

### Selector rules

- `workspace.get/focus/rename/close`: accepts mutually exclusive `workspace_id` or `workspace`.
- `tab.get`: two mutually exclusive selector groups — `workspace_id` or `workspace`, and `tab_id` or `tab`. It can read tabs from another workspace.
- `tab.focus/rename/close`: resolves `tab_id` or `tab` **only within the current workspace** and accepts no workspace selector. If the current workspace lacks that tab you get `not_found`; it does not implicitly switch and replay. Before writing a tab in another workspace, have the user pick the workspace, then re-read state.
- `tab.list` and `tab.new` accept no workspace selector.
- `workspace.new` / `tab.new` accept only the optional `if_revision` and **no `cwd`**. To target a path use `workspace.open({ path, focus?, if_revision? })`; `focus` defaults to `true`.
- What `new` or `open` returns is **not** a stable ID; `get` or `list` again.

### Write with stable IDs; use `if_revision` only when you truly need it

`if_revision` (a non-negative safe integer) compares the **whole session's event sequence number**, not a per-workspace or per-tab version.

- A sequence number that differs from the supplied value yields `revision_conflict`.
- Every published event advances the sequence (PTY ready, output, state changes), so a number read by an immediately preceding `get` is not guaranteed to still match on the next request.
- You may omit it when mutating by stable ID. Pass it only when you require "no events at all since I observed".
- When an explicit check fails, show the conflict to the user and re-read state. Do **not** drop the condition, substitute the new revision, or resend the original mutation.

### Reading, waiting and conversation

- `pane.read` takes `pane` and `lines`; `agent.read` takes `target`, `lines` and `source`. `lines` caps at 1000 and returns only trailing lines. `text`, `content_revision` and `terminal_id` are Luvus's own values.
- `agent.prompt` selects an Agent `target`. Its `until` and `timeout_s` require `wait:true`; `timeout_s` is seconds. Without waiting it returns queue admission immediately. In waiting mode, native semantics require a **new working or blocked transition** before matching `until` (native timeout default: 300 seconds).
- `agent.wait` selects a `pane`, requires exactly one of `status` or `statuses`, and accepts `timeout_s` in seconds. It has **no `wait` flag** and matches the **current state**. Multiple states match any listed state, not an ordered sequence. An immediate idle match can refer to an old idle state and does not prove a new prompt was consumed.
- `wait.output` selects a `pane` and waits for a literal `match` substring (1–4096 UTF-8 bytes, no NUL), with optional `timeout_s` in seconds (0..3600, fractions allowed). It first checks recent output, so an old marker can match immediately. Use a different marker for each execution when needed; no regex or implicit command wrapper is supported. A native `type:"wait", matched:false` response can mean timeout or pane closure, not a Gateway failure or proof that a command stopped.
- `submitted`, `queued`, `ready: true` and `observed_state` only mean **the input was submitted or recognized as ready** — not that the prompt was consumed or that the model replied. Read real state and output separately.
- Present `status` together with `authority` / `state_source`. Without positive evidence treat it as unknown; do not read idle, queued or TUI text as completion.
- An upstream model failure triggers no resend and no switch to a paid model.
- A two-turn conversation keeps the same complete target, the same pane or alias, the same `terminal_id`, and the known Agent `session`. When checking turn two, verify it recalls turn one's random content; terminal echo is not a reply.

Native request examples (use observed selectors and the user's actual message):

```json
{"method":"agent.wait","params":{"pane":"2","status":"idle","timeout_s":35}}
{"method":"wait.output","params":{"pane":"2","match":"unique_marker_for_this_execution","timeout_s":35}}
{"method":"agent.prompt","params":{"target":"selected-agent","text":"Hello","strict":true,"wait":true,"until":["idle"],"timeout_s":120}}
```

The enclosing `runtime_call.deadline` must cover the native wait plus RPC overhead; a 120-second wait can use a deadline roughly 150 seconds in the future. It remains a fixed absolute Unix millisecond timestamp, at most 10 minutes out at registration. Luvus RPC defaults to a local 10-minute cap, while endpoint discovery/schema preparation remain capped at 30 seconds; explicit shorter local settings still apply. Native `timeout_s` may allow up to 3600 seconds, but it cannot raise Rovloom's call or local deadlines. `wait_ms` only controls one short HTTP wait: poll the original call rather than replaying the prompt.

For common parameter failures on the four guided methods, read `gateway_error.details.issues` and `details.parameter_help`. `/params/pane` with `required` indicates a missing pane selector; `/params/wait` with `required_true` identifies the prompt-wait dependency. When the rejected parameter cannot be safely located, `/params` with `invalid_value` is a general diagnostic, not a specific field diagnosis. The error still carries `native_request_invalid` and `outcome:"not_dispatched"`; diagnostics omit user values and raw native errors and are not exhaustive.

Set `timeout_s` explicitly for output waits (35 seconds can use a deadline 45–60 seconds in the future). Waiting remains a blocking native RPC and occupies an execution slot; `wait_ms:0` only releases the HTTP wait. Both Gateway and Connector must support this method, and existing 35-method grants are preserved. The owner must explicitly authorize `wait.output` on both ends and in the provider raw grant; never bypass a refusal. New pairing includes it. The terminal-input switch can remain off for this read-only operation.

### Terminal command submission

`pane.run({pane, command})` submits command text to a selected terminal and returns `{"type":"ok"}`. It accepts no `cwd`, `env` or `argv` override. Read the rendered output separately with `pane.read`; the acknowledgement contains no command stdout/stderr or exit code, and it does not prove completion.

### Session resume

`agent.resume` is only for **explicitly choosing an existing session**; do not use it to probe "continue the last one". `agent.start`'s `pane` and `anchor` are mutually exclusive.

## Herdr

Herdr uses `strict` validation and its method names differ from Luvus:

| Need | Herdr method |
|---|---|
| Health check | `ping` (params `{}`, returns `type: "pong"` and `version`) |
| Snapshot | `session.snapshot` |
| Create workspace | `workspace.create` |
| Write text to a pane | `pane.send_text` (subject to the terminal switch) |
| Send keys | `pane.send_keys` (subject to the terminal switch) |

Do not reuse Luvus parameter names (for example `pane` versus `pane_id`). `agent.start` takes `pane` on Luvus and `pane_id` on Herdr; Herdr's `agent.prompt` takes `target`, `text` and an optional object-valued `wait`.

## The terminal-execution switch

The device owner sets `allow_terminal_execution` in the Connector config. It defaults to `false`, and only the literal `true` enables it. The Connector checks it locally twice (once during discovery, once immediately before writing to the native runtime); it is the **device's final gate**, and hiding tools at the Gateway is no substitute.

While it is off:

| Operation | Result |
|---|---|
| Luvus `pane.run`, `pane.send_input`, `terminal.backend.create/control/type_literal/paste_text/submit_text/send_key` | refused |
| Luvus `module.action.invoke` | refused (it invokes local module actions) |
| Luvus `agent.report`, `pane.report_session`, `pane.report_event` | refused (they change the runtime's judgment of the Agent; otherwise a shell could be marked as an Agent and then typed into) |
| Luvus `agent.keys` | always refused (a report or session marker cannot prove the foreground program is an Agent) |
| Luvus `agent.send`, `agent.prompt` | only text with an explicit `strict: true` in the request is accepted |
| Luvus `task.add` / `task.start` with a non-empty `gate` or custom `agent` | refused |
| Luvus `task.done` / `task.retry` | refused (they may run a saved gate or restart the original run) |
| Herdr `pane.send_text`, `pane.send_keys`, `pane.send_input`, `pane.link.activate` | refused (links can invoke local handlers) |
| Agent start, workspace/tab/pane creation, session resume with non-empty `command`, `args`, `env`, `resume_command` or `resume_argv` | refused |
| Strict Agent text conversation, reads, `agent.start` without custom launch arguments | unaffected |

`runtime_discover` reports the current state in `terminal_execution`:

- `local_state`: `enabled` / `disabled` / `unknown`
- `requires_explicit_strict: true`: you must send `strict: true` to call it
- `request_parameters_checked: true`: parameters are checked individually

You **cannot** turn this switch on remotely. Report refusals faithfully and do not try to work around them (for example by renaming the method or mangling parameters).

## Result semantics

- `native_response` keeps the runtime's original values.
- Herdr's `ok` and Luvus's `queued` / `executed` only mean **the input operation succeeded**, not that the shell command finished.
- `pane.read` / `agent.read` return a terminal screen that may be rendered and truncated, and they keep the runtime's truncation information. It is not lossless stdout/stderr.
- The outer `exit_code` in a Luvus RPC result belongs to the fixed CLI proxy and is `null` over IPC — it is **not** the exit code of a command inside the terminal.
- Closing a pane, timing out, or cancelling proves no success and rolls back nothing.
- A call that was sent but never answered stays `outcome_unknown` and is never resent automatically. Once a dispatch record exists, turning the switch off afterwards still cannot clear the record for re-execution.

## Failures and unavailability

- When a device is offline, new calls return `unavailable` immediately (milliseconds, no hang); they do not queue waiting for a reconnect.
- After a Connector disconnect, revocation, rebind or shutdown, the Gateway stops using the old source; a new connection must deliver again. Existing calls, result handles and unacknowledged responses are **not** migrated to the new connection and are not resent.
- When the instance, contract or capabilities change, the Connector closes the connection itself. After reconnect `binding_revision` may have changed, so re-run `providers_get` plus `runtime_discover`.
- One provider failing does not mean the device is offline, and vice versa: check `providers_get.readiness` and `machines_get.link` separately.
- A roughly 30-second cutoff despite a later call deadline can indicate an older Connector or an explicit shorter local timeout. The long-RPC fix requires updating/restarting the Connector; updating only the Gateway supplies metadata/diagnostics, not that local fix. Existing pairing, config and tokens can be retained. An already-sent call with no result still remains `outcome_unknown`; do not replay it.
