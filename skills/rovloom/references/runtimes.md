# Runtime semantics

MCP only forwards `method` and `params`; the parameters and behavior come from each runtime's native contract. **Describe first, then fill parameters from the schema** — never write field names from memory. This file covers the Luvus and Herdr differences that matter most, plus the traps that make calls fail or mislead.

## Luvus

Corresponds to Luvus 0.14.3. The authoritative method list is `src/runtime/luvus-operations.ts`; the Gateway only lets through methods in its static table.

### There is no `window.*`

Luvus uses three levels: workspace → tab → pane. There is no window concept. A call like `window.list` returns `unsupported`.

### Discovery and selection

| Need | Method |
|---|---|
| Whole-session snapshot | `session.snapshot` |
| Workspace | `workspace.list` / `get` |
| Tab | `tab.list` / `get` (`tab.list` covers only the current workspace) |
| Pane | `pane.list` / `get` / `current` |

`pane.list` accepts only the optional `all_tabs` (boolean, default `true`) and takes **no** workspace or tab selector. To filter by workspace, `workspace.focus` first, or read the hierarchy from `session.snapshot` and then `pane.get` each pane. `pane.get` takes a `pane` argument.

Prefer saving **stable IDs** such as `workspace_id`, `tab_id` and `terminal_id`; do not rely on titles, positions or "the most recent object".

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
- `agent.prompt`'s `until` and `timeout_s` must be used together with `wait: true`.
- `submitted`, `queued`, `ready: true` and `observed_state` only mean **the input was submitted or recognized as ready** — not that the prompt was consumed or that the model replied. Read real state and output separately.
- Present `status` together with `authority` / `state_source`. Without positive evidence treat it as unknown; do not read idle, queued or TUI text as completion.
- An upstream model failure triggers no resend and no switch to a paid model.
- A two-turn conversation keeps the same complete target, the same pane or alias, the same `terminal_id`, and the known Agent `session`. When checking turn two, verify it recalls turn one's random content; terminal echo is not a reply.

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
