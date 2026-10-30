# Rovloom configuration reference

**English** · [简体中文](CONFIGURATION-zh.md) · [Quick Start](QUICK-START.md)

Each role has **one user JSON file**: `~/.config/rovloom/gateway.json` or
`~/.config/rovloom/connector.json`. Starting a role creates its missing file.
Existing files are read strictly and never reset. All fields below are required
unless marked optional. Defaults describe the generated file, not fallback values
for missing fields. Examples contain no credentials.


## Explicit initialization

```sh
rovloom config init connector --provider herdr
rovloom config init gateway --container
```

`--provider` accepts `luvus`, `herdr` or `mixed` for Connector only. `--container` applies to Gateway only and explicitly binds MCP, devices and management to `0.0.0.0`; keep the maintained Compose MCP / management mappings on host loopback. MCP, the management UI and its APIs support reverse proxies without an external URL setting. Without this flag, Gateway keeps the normal defaults (wildcard MCP and device listeners, loopback management). `--config` chooses the configuration file, while the default state path still belongs to the current user's home.

Initialization does not start services, create device identities or authorize native access. It uses the same exclusive first-file publication as role startup. Existing files are never overwritten; an explicit provider / listener request that conflicts with them returns `config_exists`. To edit an existing deployment, first review its configuration and pairing state, then use `config check` before restarting.


## Complete minimal configurations

Gateway, normally `~/.config/rovloom/gateway.json`:

```json
{
  "schema_version": 1,
  "role": "gateway",
  "data": {"directory": "/home/your-user/.local/share/rovloom/gateway"},
  "mcp": {"hostname": "127.0.0.1", "port": 9444},
  "devices": {"hostname": "127.0.0.1", "port": 9443},
  "management": {"enabled": true, "port": 9445}
}
```

Connector, normally `~/.config/rovloom/connector.json`:

```json
{
  "schema_version": 1,
  "role": "connector",
  "data": {"directory": "/home/your-user/.local/share/rovloom/connector"},
  "gateway": {"url": ""},
  "allow_terminal_execution": true
}
```

Replace `/home/your-user` with your actual home when saving an example. The
generated file already contains the real home. The Gateway starts with these
defaults and no identities. A blank Connector address is valid: a local terminal
prompts for it, and non-TTY startup returns `configuration_required` (2).
Setting an address does not pair the device or install a native provider.

## Every user parameter

| Field | Type / required | Generated default / effect |
|---|---|---|
| `schema_version` | Integer, required | Exactly `1`. |
| `role` | String, required | `gateway` or `connector`, matching the command. |
| `data` | Object, required | Contains only `directory`. |
| `data.directory` | Normalized absolute path string, ≤4096 characters, required | `<home>/.local/share/rovloom/<role>`; separate private data for each role. |
| Gateway `mcp` | Object, required | Contains `hostname`, `port`; Streamable HTTP `/mcp`. |
| `mcp.hostname` | String, required | Accepts `127.0.0.1`, `::1`, `0.0.0.0`, `::`. It selects the listening interface, not allowed proxy domains. MCP accepts HTTP/HTTPS proxy addresses and preserved or rewritten Host headers on `/mcp`; every request still requires its Bearer. |
| `mcp.port` | Integer 1–65535, required | `9444`. |
| Gateway `devices` | Object, required | Contains `hostname`, `port`; WS `/connector`. |
| `devices.hostname` | String, required | `127.0.0.1`; also `::1`, `0.0.0.0`, `::`. A wildcard bind accepts remote devices. |
| `devices.port` | Integer 1–65535, required | `9443`. |
| Gateway `management` | Object, required | Contains `enabled`, `hostname` and `port`; local HTTP management page. |
| `management.enabled` | Boolean, required | `true`; `false` disables this listener. Enabling it grants no administrator identity. |
| `management.port` | Integer 1–65535, required even when disabled | `9445`. |
| `management.hostname` | String, optional, written by default | `127.0.0.1`; also accepts `0.0.0.0` for LAN access. The bind controls the listening interface, not a domain whitelist. Management supports HTTP/HTTPS reverse proxies that preserve or rewrite `Host`, without an external URL setting. Login, session cookies and CSRF remain required; browser cross-site requests are refused. HTTPS is detected from the request, browser Origin, `X-Forwarded-Proto` or `Forwarded` to add `Secure` to cookies. |
| Connector `gateway` | Object, required | Contains only `url`. |
| `gateway.url` | String, required | `""` while setup is pending; otherwise WS/WSS origin, ≤2048 characters, e.g. `ws://192.0.2.10:9443` or `wss://gateway.example`. No credentials/query/fragment/path except optional trailing `/`. Product selects `/connector`. |
| Connector `allow_terminal_execution` | Boolean, optional | `true`, also when omitted. Only literal `false` disables direct terminal input and custom launch/restore commands through the existing local guard; set it on a device that should only accept strict Agent text conversation and reads. A file generated by an earlier version already contains the value explicitly, so its choice is kept; only a file that omitted the key turns on. Edit this single user file and restart Connector; it does not change installation settings or token device scopes. |
| Connector `native` | Object, optional | Absent by default. Contains only the provider-selection and installation-directory settings below; applied at first native initialization. |
| `native.provider` | String enum, optional | Omitted: `luvus`; `herdr` selects Herdr, `mixed` selects one of each. Choose it before native initialization; it cannot change afterwards. |
| `native.runtime_bin_dirs` | Array of 1–16 distinct normalized absolute directory strings (each ≤4096 characters), optional | Where to look for the selected `luvus`/`herdr` programs. Search order: these directories, then the usable entries of the Connector's `PATH`, then `/usr/bin:/bin` (not on Windows). Different programs may live in different directories. No shell expansion or executable argv. |
| `native.agent_bin_dirs` | Array of 1–16 distinct normalized absolute directory strings (each ≤4096 characters), optional | Directories searched for Agent programs. The Agent PATH is fixed at native setup in the same order. Rovloom does not install or authenticate an Agent. |
| `native.herdr.mode` | `"attach"` (default) or `"managed"`, optional | Herdr only. `attach`: connect to the Herdr you already run, start one in your own config directory only if none is running, and re-attach/re-create it when it disappears. `managed`: a private isolated instance owned by the Connector. See [Herdr: attach or managed](#herdr-attach-or-managed). |
| `native.luvus.mode` | `"attach"` (default) or `"managed"`, optional | Luvus only. `attach`: connect to your own `default` session, start one in your own `LUVUS_HOME` only if none is running, and re-attach/re-create it when it disappears. `managed`: a private isolated instance (session `rovloom`) owned by the Connector. See [Luvus: attach or managed](#luvus-attach-or-managed). |
| `native.luvus.state_root` | Normalized absolute directory string, optional | Attach mode: your Luvus state directory (default `$LUVUS_HOME` from the Connector's environment, else `~/.luvus`). Created with mode 0700 if missing; it must be private. |
| `native.herdr.config_home` | Normalized absolute directory string, optional | Attach mode: the config directory your Herdr uses (default `$XDG_CONFIG_HOME`, else `~/.config`). Set it when the Connector runs as a service whose environment differs from your terminal. |

Enabled Gateway listeners must use different ports. Unknown fields, old flat
fields, runtime/ref selectors, TLS/CA paths, schema hashes, binary pins and
credential values are rejected. There are no user parameters for native roots,
ledgers, bindings or identity digests. After native initialization, changing the
native installation settings or the Connector's Gateway URL is rejected, so a saved
device credential is never sent to another origin.

Paths are absolute and normalized, not relative to the JSON file. JSON does not
expand `~` or environment variables. The default role path always uses the
process user's home, including on Windows. `--config` takes an absolute file path
and overrides only that file's location; generated data still defaults to the
user's home.

Newly created files and directories request `0600`/`0700` where supported.
Existing permissions and malformed files are never repaired automatically.
User JSON is limited to 16 KiB, has no comments, and rejects malformed encoding
and duplicate keys. See [platform availability](#platform-availability) for
supported systems.

## Program-managed data and authentication

You edit only the role file. `data.directory` is where Rovloom keeps its
databases, device credentials and native state. Rovloom prepares these itself
during startup and approved setup; do not create `runtime.json`, `refs/`,
provider JSON or credential files.

Keep the data directory as a whole, including companion database files. Do not
edit its records or delete them to retry an uncertain setup. Herdr uses
`<data.directory>/hr/` for its isolated directories. For first Luvus setup,
`data.directory` plus `/n` must fit within 52 UTF-8 bytes; choose a shorter
directory before pairing if necessary.

A Gateway with no caller state is in the **pairing required** state. MCP returns
401 and the management page shows only an empty shell until an administrator
exists. The first pairing creates one local caller for the reviewed Target.
Its Bearer is shown only on the verified local terminal and kept privately by
Rovloom. Copy it into the MCP client's secret storage. It expires after 30 days
by default and is managed with `rovloom token`. Device credentials, MCP Bearers
and administrator passwords are separate; an MCP Bearer cannot sign in to the
management page. When first pairing completes through the Gateway terminal, it
creates the administrator `admin` and prints its password once next to the MCP
Bearer. Manage administrators afterwards with `rovloom admin`.

You can also create the first administrator **before any pairing**
(`rovloom admin create` initializes the empty caller registry), sign in to the
management page, and complete first pairing entirely from the page; see
[Pairing](#pairing). Declining the terminal pairing prompt keeps the Gateway
running unpaired and prints this web-first path.

### Managing the management-page administrator

```text
rovloom admin create [--principal admin] [--ttl-days 30]
rovloom admin list
rovloom admin revoke [--principal admin]
```

The management page (default `http://127.0.0.1:9445/`) signs in with HTTP Basic: the user name is
the administrator ID (default `admin`) and the password is what `create` writes to stdout, **once**
(everything else goes to stderr). Gateway keeps only its SHA-256 digest in
`managed/management.json`. Creating, re-issuing and revoking take effect **without a restart**:
re-issuing an existing ID (the way to recover a lost password) replaces its password and
invalidates browser sessions signed in with the old one; revoking does the same. An
administrator can see and manage every device and provider the Gateway knows, including ones paired
later, but cannot call MCP. `rovloom admin create` also works on a Gateway that has
not completed first pairing: it initializes the caller registry the login flow needs,
so the management page is available before the first device exists. In Docker use
`docker compose run --rm gateway admin create`.

### Managing Bearer tokens

```text
rovloom token list
rovloom token create --principal worker --like owner [--ttl-days 30]
rovloom token renew  --principal owner [--ttl-days 30]
rovloom token rotate --principal owner [--ttl-days 30] [--grace-minutes 10]
rovloom token revoke --principal worker
rovloom token scope  --principal worker --devices m_ab12,m_cd34
rovloom token scope  --principal worker --all-devices true
rovloom token scope  --principal worker --no-devices true
```

The token registry (`managed/mcp-callers.json` under the Gateway state directory)
holds SHA-256 digests, recoverable newly issued tokens, principal identities, device scopes and fixed expiry. The Gateway re-reads
it on every authentication, so create, renew, rotate and revoke take effect **without a
restart**, and revoking also invalidates established MCP sessions. `create` and
`rotate` write the new token to stdout exactly once (everything else goes to stderr);
a new principal's device scope is cloned from `--like`. `rotate`
invalidates the old token immediately unless `--grace-minutes` gives clients a bounded
switch-over window. A local `mcp-client.json` belonging to the same principal is
updated too. A corrupt registry denies all authentication until it is repaired.

### Device visibility scope

MCP authorization has two controls for both Herdr and Luvus: the token's device scope, and the Connector's `allow_terminal_execution` switch for direct terminal input/execution and custom commands. There are no per-method, per-provider or read/dispatch/cancel grants.

New registries use `schema_version: 2`. A caller entry contains its identity, credentials, expiry and optional device scope:

```jsonc
{
  "principal": { "id": "worker" },
  "token_sha256": "…",
  "device_scope": { "mode": "selected", "machine_ids": ["m_ab12", "m_cd34"] },
  "issued_at": 1000,
  "expires_at": 86401000
}
```

- No scope means all active devices, including devices paired later.
- `selected` accepts 0–256 unique stable machine IDs. Names are not accepted. An empty list blocks all devices.
- Use `token scope --devices ...`, `--no-devices true` or `--all-devices true`. Changes apply without a restart; `token create --like` copies the scope. Pairing does not change existing scopes.
- Lists and descriptions hide out-of-scope devices with `not_found`. Dispatch, cancellation and result access reject with `forbidden`. Each request uses the current identity and scope; an already dispatched native operation is not stopped by narrowing scope.
- Every provider-exposed method on a visible device is available, subject to the Connector's terminal switch and actual native availability. Parameters, source/binding, deadlines and idempotency are checked for correctness. Calls and results retain their original principal ownership.

Version 1 registries are read without rewriting the file. On migration, an ordinary legacy caller's own grants contribute only their machine IDs to `device_scope`; an explicit scope takes precedence. Legacy Gateway-scoped and pairing callers keep their global scope. `local_policy` is never used to expand device visibility. The next registry write saves version 2 and omits all old policies, methods, actions, revisions and result-discard permissions. Administrator-only records remain excluded from MCP authentication; management roles are independent.

Upgrade and restart both Gateway and Connector. Existing tokens and pairing credentials remain usable; no re-pairing or per-method authorization update is needed. Old Connector policy/raw fields are accepted as inert compatibility input and omitted from new pairing output. Before upgrading, back up both roles' complete private data directories and configs while stopped. Rolling back requires restoring those matching backups and binaries: old releases cannot consume the new registry/config format safely.

### Pairing

A Connector needs a reachable Gateway address and completed pairing. Pairing is
single-code and direct: the management page (or `rovloom gateway --issue-code`)
generates a per-device code and displays the full join command, and the
Connector machine runs `rovloom connector --join ws://<address>#<code>` once —
no applications, approvals, check codes or terminal prompts. The command writes
the Gateway address, scans the local native installation, exchanges the code
for a device credential (the Gateway stores only its digest) and starts
running; the first device also prints the MCP URL and Bearer.

- One code per device: the first successful exchange consumes the code; used,
  revoked or failed codes cannot be exchanged again — generate a new one.
  Plaintext of unused codes stays in the Gateway's private state directory so
  the page can redisplay them; it is wiped when a code terminates.
- Running the join command again with a fresh code re-pairs this machine as a
  new device; the previous local pairing state, including managed native roots,
  is retired to `state/retired/` (managed instance data is preserved for manual
  recovery). Use this path when a credential is lost or revoked. A join command
  from a different Gateway likewise retires the old state and pairs there;
  `rovloom connector --unpair` only retires and clears the address, without
  pairing immediately.
- Device credentials do not expire. They stop working on revocation or
  re-pairing; a revoked device can only return as a new device.

Native initialization is approved automatically: the Gateway compiles and
verifies the measured installation manifest submitted by the device, publishes
the provider and caller configuration and hot-reloads, with no downtime. Native
initialization does not log in to a model provider, create an Agent or prove a
model reply.

`config check-runtime` checks the existing provider registry only. It does not
check caller credentials, TLS trust, native binaries or a model connection.

## Network access

Gateway uses ordinary HTTP/WS for local/trusted-network access. Public TLS belongs
to an external standard HTTPS/WSS reverse proxy. Connector WSS always uses system
certificate validation. There is no custom CA or skip-verification option.

MCP, the management UI and management APIs accept reverse proxies that preserve or
rewrite Host, with HTTPS outside and HTTP upstream. No public URL, allowed-domain
or trusted-proxy configuration is required. **Before upgrading, remove the retired
`mcp.public_url` field from older configuration files. Leaving it present causes
`config check` and Gateway startup to fail with `invalid_config`; it is not ignored.**
Configure the external HTTPS `/mcp` URL in
the AI client; the local endpoint printed by Gateway remains useful for local clients.
Preserve `/mcp`, `/admin/v1/…`, Authorization and MCP session headers. Forward MCP
SSE responses without buffering. Management requests still require administrator
cookies and write CSRF; every MCP request still requires its current Bearer.

For LAN clients without a proxy, set `mcp.hostname` / `management.hostname` to a
wildcard address. Those listeners then accept LAN hosts over plain HTTP — the
MCP listener requires its Bearer, and the management page keeps its cookie,
CSRF and same-origin checks, but neither has transport encryption or
network-layer isolation. Keep a firewall around the LAN and
put a TLS reverse proxy in front of anything that leaves it.

## Native installation

Install the native programs from their official [Luvus](https://github.com/RizRiyz/luvus/releases/latest)
or [Herdr](https://github.com/herdrdev/herdr/releases/latest) releases. Compatibility
is decided by the installed protocol, the complete request/response schema and the
methods actually offered. Version labels are diagnostic only. A missing or
incompatible optional interface disables only the operations that depend on it.

| Integration basis | Luvus | Herdr |
|---|---|---|
| Schema command | `luvus uhp schema` | `herdr api schema --json` |
| Protocol basis | UHP v1 envelope and live method catalog | Schema protocol and complete JSON RPC roots |

The program-managed state and each live source must agree on the binary and
schema hashes. These are integration checks, not user JSON fields. Rovloom does
not install native programs or prepare model access.

## Herdr: attach or managed

**attach (default).** Setup records your real `HOME` and XDG directories (taken from the Connector's
environment, or `native.herdr.config_home`). On every start the Connector:

1. looks for a Herdr server on the default session's endpoint and attaches only if the peer is
   proven to be your installed `herdr`: same user, the process executable is the same file as the
   configured binary, and its command line is `herdr server` (or `--session <name> server`);
2. otherwise starts `herdr --session <name> server` in your config directory, detached — it keeps
   running (and keeps your workspaces) after the Connector exits;
3. watches the instance. If it disappears, the Connector closes the old resources, re-attaches or
   starts a new one with backoff, and ends the current connection so the next connection
   uses the new instance. Calls in flight at that moment stay `outcome_unknown` and are never resent.

A listener that is **not** your installed `herdr` is never attached and never replaced. The server
the Connector starts gets your shell and Git configuration but not other environment variables
(SSH agent, API keys); configure Agent credentials in the Agent's own files.
Remote callers act on your **real** workspaces; the token device scopes and `allow_terminal_execution`
remain the only fences.

**managed.** A private instance under the Connector's data directory (`<data.directory>/hr`), owned
by the Connector and stopped with it. Nothing in your ordinary home is shared.

## Luvus: attach or managed

**attach (default).** The Gateway pairing target is your `default` session (the Gateway
prompt shows `session: default`). Setup records your real `HOME` and state directory
(`native.luvus.state_root`, else `$LUVUS_HOME`, else `~/.luvus`). On every start the Connector:

1. asks the pinned `luvus` for its sessions (`session list --json`, run with a private HOME so it
   reads nothing else) and attaches only if `default` is running **and** the peer on its socket
   is proven to be your installed `luvus`: same user, the process executable is the same file
   as the configured binary, and its command line is `luvus [--session default] server`;
2. otherwise starts `luvus --session default server` detached, with your real `HOME`, your shell
   and `LUVUS_HOME` (but not SSH agent or API-key variables), so it keeps running after the
   Connector exits;
3. watches the instance. If it disappears, the Connector re-attaches or starts a new one with
   backoff and ends the current connection so the next connection uses the new
   instance. Calls in flight at that moment stay `outcome_unknown` and are never resent.

A server on that endpoint that is **not** your installed `luvus` is never attached or replaced.
Remote callers act on your **real** workspaces; the token device scopes and
`allow_terminal_execution` remain the only fences.

**managed.** A private instance (session `rovloom`) under the Connector's data directory, owned
by the Connector and stopped with it. The data directory path plus `/n` must fit 52 bytes.
Nothing in your ordinary home is shared.

## Restart after a crash

If the Connector is killed (`kill -9`, power loss), it leaves an owner record, the
native endpoint sockets and the claim-ledger lock behind. On the next start it
clears them **only** when it can prove the previous owner is gone: the recorded
owner process no longer exists (Linux; checked by PID and kernel start time) and
nothing listens on the native sockets. It then prints `herdr_crash_residue_cleared`
to stderr and starts normally. The claim ledger and its dispatch records are never
touched, so a possibly-executed call is never resent. If the old owner is alive,
a native process still listens, the record is unreadable or the platform is not
Linux, the start is refused (exit code 3). Stop the surviving process first.

Luvus works the same way for its two crash locks, the claim-ledger lock and the
root owner lock. Each records the owning process. A lock is removed only when that
process is gone and, for the owner lock, nothing listens on the session's Luvus
sockets. Rovloom then prints `luvus_crash_residue_cleared` to stderr. Unreadable
locks and non-Linux platforms stay refused until you remove the lock by hand.

## Program and Agent installation directories

Install the runtime (`luvus`/`herdr`) and the Agent, such as OpenCode, wherever
suits the machine; they need not share a directory. By default Rovloom finds them
through the `PATH` the Connector was started with, plus `/usr/bin:/bin`. It does
**not** use your login shell's PATH: the search path is computed once at native
setup, stored in the protected installation record and re-checked on every start.

Only some `PATH` entries qualify. An entry is used when it is a normalized absolute
path to a real directory (not a symlink, file or missing path) owned by root or the
Connector user and not writable by group or others; anything else is skipped silently.
At most 16 directories are kept, explicit ones first. If a service manager gives the
Connector a minimal `PATH`, list the directories explicitly in the single Connector
user file **before running `connector --join`**:

```json
{
  "native": {
    "runtime_bin_dirs": ["/opt/herdr/bin", "/home/your-user/.local/bin"],
    "agent_bin_dirs": ["/home/your-user/.local/bin", "/home/your-user/.opencode/bin"]
  }
}
```

Both fields are optional arrays of normalized absolute directories (no `~`, variables,
relative paths, `..`, trailing slash or PATH-style `a:b` strings; no duplicates).
Explicit directories are trusted exactly as written, so keep them under the machine
owner's control. A same-named program in an earlier directory wins. This is a native
installation setting, not an executable path, MCP argument or CLI flag.

Configure Agent and model access in the runtime's private HOME/XDG locations.
In managed mode its HOME is `<data.directory>/h` (Luvus) or `<data.directory>/hr/h`
(Herdr). A login in your usual home is not copied, so the machine owner prepares
model access for that environment. Plain text conversation works with
`allow_terminal_execution` set to `false`. The terminal switch does not sandbox an
Agent's own tools. A `ready` state alone is not evidence that a model replied.

Direct terminal operation uses the native methods: Luvus `pane.run` takes an
explicit `pane` and `command`; read the output with `pane.read`. Its `ok`
acknowledges PTY input, not command completion or an exit code. The Gateway
catalog hides direct input while the local switch is off or unknown. Policies
created before the switch was enabled may still exclude `pane.run`. See
[terminal execution](TERMINAL-EXECUTION.md).

## CLI reference

`ROLE` means `gateway` or `connector`; `ABS` means a normalized absolute path
passed as a separate argument. Commands and options are case-sensitive. The
`--option=value` form, combined short flags and extra arguments are not
accepted. Only top-level help has a short flag.

### Help, version and configuration

| Command | Arguments / options | Effect |
|---|---|---|
| `rovloom`, `rovloom --help`, `rovloom -h`, `rovloom help` | None | Prints top-level help. |
| `rovloom gateway --help`, `rovloom connector --help` | Exactly `--help` | Prints top-level help. |
| `rovloom --version` | None | Prints the product version. There is no `-v` alias. |
| `rovloom config template ROLE` | Required `ROLE` | Prints the complete non-secret role JSON; writes no file. |
| `rovloom config check [--role ROLE] [--config ABS]` | Both optional, in either order | Without options, checks both default user files and reports each. `--role` selects one role; `--config` overrides its path. Read-only; never creates a file. |
| `rovloom config check-runtime [--role ROLE] [--config ABS]` | Same as `check` | Also checks the existing program-managed provider state. No credentials are loaded and no Agent readiness is claimed. |

An explicit file without `--role` is checked as the role it declares; with
`--role`, a mismatch is an error. When both roles are checked, an error in one
does not skip the other, and any failure returns nonzero.

### Run a role

| Command | Effect |
|---|---|
| `rovloom gateway [--config ABS] [--non-interactive]` | Starts the foreground Gateway. Default file: `~/.config/rovloom/gateway.json`. |
| `rovloom connector [--config ABS] [--non-interactive]` | Starts the foreground Connector. Default file: `~/.config/rovloom/connector.json`. |
| `rovloom gateway --issue-code [--config ABS]` | Prints one per-device pairing code and the full join command at startup. |
| `rovloom connector --join <ws://host:port#code> [--config ABS]` | Pairs with the Gateway and starts in one step; no prompts. |
| `rovloom connector --unpair [--config ABS]` | Retires all local pairing state (including managed native roots) to `state/retired/` and clears the Gateway address; stop the Connector first. |

An explicit `--config` takes priority and never falls back to the default. The
file must match the role. A missing file is created at the selected path; an
existing file is never overwritten. Stop a foreground role with Ctrl-C. There
is no `start`, `stop` or `restart` command at the top level. Ports are JSON
fields, not flags.

`--issue-code` and `--join` need no local terminal and
cannot be combined with `--non-interactive`. `--non-interactive` disables the
local setup prompts; the Windows service passes it automatically.

### Service commands

`rovloom service --help` works offline. Installation needs the current
standalone binary, normal system-service authorization, an existing non-root
account and an existing working directory. A missing configuration file is
created at the first normal start. See [SERVICE](SERVICE.md) for prerequisites
and platform limits.

| Command | Required arguments | Effect |
|---|---|---|
| `rovloom service install` | `--role`, `--workdir`, `--user`; optional `--executable`, `--config` | Registers startup at boot. **Does not start now.** |
| `rovloom service start` | `--role` | Starts an installed role now. |
| `rovloom service restart` | `--role` | Stops the installed instance, then starts it. |
| `rovloom service stop` | `--role` | Stops now and keeps startup at the next boot. |
| `rovloom service uninstall` | `--role` | Removes startup at future boots. **Does not stop** a running instance or delete data. |

Example (Linux):

```sh
rovloom service install --role gateway --workdir /home/rovloom --user rovloom
rovloom service start --role gateway
```

Each action selects exactly one role; repeat it for the other role. There is no
default role, `all`, `--now`, `--force`, `--purge` or `service status`.

| Option | Applies to | Meaning |
|---|---|---|
| `--role` | All actions | `gateway` or `connector`. |
| `--executable` | install, optional | Absolute path, at most 4096 characters. Defaults to the current standalone binary and must equal it. On Windows it must end in `.exe`. |
| `--config` | install, optional | Absolute path, at most 4096 characters. Defaults to the current user's role file. Install records this path; later starts do not resolve another home. Pass it explicitly when running through sudo. |
| `--workdir` | install, required | Absolute working directory, at most 4096 characters. It does not replace `data.directory`. On Linux it cannot end in whitespace or a backslash. |
| `--user` | install, required | Existing non-root account (Linux/macOS), or existing user name or SID (Windows, S4U, no password stored). |

Start and restart require an installed registration. A repeated start does not
create a second instance. Windows stop and restart may end the task directly.

Successful service output is a JSON line on stderr with `bootEnabled`,
`controlRetained` and `readiness: "not_checked"`. Use the foreground process and
the checks in the [Quick Start](QUICK-START.md) to confirm readiness. A running
process alone does not prove MCP or Agent readiness, and an HTTP client
disconnect does not stop the Gateway.

### Platform availability

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| Help, version, template, `config check` | Yes | Yes | Yes |
| Role file creation, Gateway start, `config check-runtime` | Yes | Yes | Yes |
| Pairing (`connector --join`) and native setup | Yes (x64) | Yes (x64, arm64) | Yes (x64) |
| Native Connector | x64 | x64, arm64, attach mode only | x64, attach mode only |
| Service: Gateway | systemd | LaunchDaemon | boot task (S4U) |
| Service: Connector | x64 | x64, arm64, LaunchDaemon | x64, boot task (S4U) |

On macOS and Windows the Connector attaches to the Herdr or Luvus you already run and
starts one only if none is present; `managed` mode is not supported there.

### Output and exit codes

Help, version, check results and service diagnostics go to **stderr**. Template
JSON goes to **stdout**. Stdout is not an MCP transport. No option accepts
Bearers, TLS or model secrets, or arbitrary environment variables.

| Exit code | Meaning |
|---|---|
| `0` | Success, normal shutdown, or an idempotent service action. |
| `1` | Runtime or shutdown failure; service action failure (including `permission_denied`; Rovloom never invokes sudo). |
| `2` | Invalid arguments or configuration, including `invalid_arguments` and `configuration_required`. |
| `3` | Backend or runtime unavailable, unsupported service platform, or a start refused because of crash residue. |

Keep the error code when asking for help. Do not post real configuration,
Bearers, administrator passwords or pairing codes.


### Result cleanup

After saving the needed result, call `runtime_response_discard` with its `call_id` to delete its original content and handles. Current identity, device scope and original result ownership are checked; there is no separate discard permission or `token permissions` command. Reading to EOF does not delete or renew the result.

Validated responses are persisted on arrival. Their handles remain readable until the fixed TTL even after the original connection closes, subject to Store content/handle budgets and device lifecycle. Result reads do not require a live original Wire or revalidate the native schema. The production runtime releases completed execution contexts rather than retaining one for every stored result.
