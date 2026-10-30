# Rovloom Quick Start

**English** · [简体中文](QUICK-START-zh.md) · [Configuration reference](CONFIGURATION.md)

Rovloom has two roles:

- **Gateway** — the MCP entry point your AI client talks to.
- **Connector** — runs on each machine that has Herdr or Luvus and connects out to the Gateway.

Both roles can run on the same machine. The Gateway runs on Linux, macOS and Windows; the
Connector runs on Linux x64, macOS (x64, arm64) and Windows x64. On macOS and Windows it attaches to the Herdr or Luvus you already run.

## 1. Install

**Linux / macOS** (x64 or arm64). Linux needs glibc **or** musl — the installer picks the
matching asset. The musl build also needs the C++ runtime (`apk add libstdc++` on Alpine) and
cannot run Luvus managed native processes; see [Distribution](DISTRIBUTION.md).
No Bun, Node or root access required:

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

**Windows PowerShell** (x64 or arm64):

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.ps1 | Invoke-Expression
$env:Path = "$env:LOCALAPPDATA\Rovloom\bin;$env:Path"
```

Both installers verify the binary against the release `SHA256SUMS`, install only the binary
(to `~/.local/bin/rovloom` or `%LOCALAPPDATA%\Rovloom\bin\rovloom.exe`), and do not create
configuration or services. Add that directory to your PATH permanently, then check:

```sh
rovloom --version
```

Binaries are also on the [releases page](https://github.com/ArnoChenFx/rovloom/releases/latest);
installer options are in [Distribution](DISTRIBUTION.md).

**Already have Bun (1.4.4 or newer)?** Rovloom is on the npm registry; install it globally, or run it
once without installing:

```sh
bun add -g rovloom
rovloom --version
bunx rovloom --version
```

Prefer pinned releases? Every release also carries the same package tarball as a release asset:

```sh
bun add -g https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz
bunx --package https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz rovloom --version
```

Upgrade with `bun update -g rovloom` (or repeat `bun add -g` with the new release's URL). The package
only runs on Bun, and `rovloom service install` still requires the standalone binary above.

**Gateway in Docker (Linux x64/arm64, Docker Compose v2)** — optional, instead of installing the
binary on the Gateway host:

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
```

Ports 9443, 9444 and 9445 must be free (the Compose file publishes them from a bridge network); the image sets `ROVLOOM_CONTAINER=1`, so first startup generates the container listeners (all three on `0.0.0.0`) automatically. See
[Docker deployment](DOCKER.md) for volumes, backup and upgrades.

## 2. Prepare the Connector machine

A Connector manages nothing by itself: it reaches sessions through a runtime, so this machine needs
**Herdr** or **Luvus** installed before any device can pair — one of the two is required. Install the
Agent you want to use as well and sign in to your model provider. Rovloom installs none of these.

| Platform | Herdr | Luvus |
|---|---|---|
| Linux x64 / arm64 | `curl -fsSL https://herdr.dev/install.sh \| sh` | `curl -fsSL https://luvus.dev/install.sh \| sh` |
| macOS x64 / arm64 | same command as Linux, or `brew install herdr` | same command as Linux, or `brew install RizRiyz/luvus/luvus` |
| Windows x64 | `irm https://herdr.dev/install.ps1 \| iex` | `irm https://luvus.dev/install.ps1 \| iex` |

Both projects publish per-OS and per-architecture builds and list every archive on their releases
pages ([Herdr](https://github.com/herdrdev/herdr/releases/latest),
[Luvus](https://github.com/RizRiyz/luvus/releases/latest)); install that way when a script or
Homebrew is not available. On Windows arm64 Herdr's installer falls back to the x64 build under
emulation, and Luvus prebuilt binaries are x64 only — the same limit the Connector has.

Both installers put the binary on `PATH` — Herdr in `~/.local/bin`, Luvus in `/usr/local/bin` when
writable and `~/.local/bin` otherwise — and print the directory they used. Programs are found through
the `PATH` the Connector starts with (plus `/usr/bin:/bin`), so if the installer asks you to extend
`PATH`, do that for the Connector too, or list the directory in `native.runtime_bin_dirs` — see
[installation directories](CONFIGURATION.md#program-and-agent-installation-directories).
`herdr --version` or `luvus --version` should answer before you pair; when the selected runtime is
missing, pairing stops with `configuration_required`.

The Connector **attaches to the session you already run**, so remote calls act on your real
workspaces and Agent logins. It starts one in your own config directory only if none is running.

Luvus is the default. Before first pairing, choose Herdr explicitly (use `mixed` for both — that
needs both installed):

```sh
rovloom config init connector --provider herdr
```

This creates configuration without starting the Connector or asking for an address. Existing configuration is preserved; if it selects another provider, the command returns `config_exists` so you can review it before changing it.

## 2b. herdr-core (Linux only, core 0.1.14)

herdr-core is a third runtime: the core's own agent-management API over a unix socket, not the Herdr
TUI. It is Linux-only and pinned to core **0.1.14** — the handshake refuses any other version, and the
binary digest is recorded at pairing.

Install it from the official release manifest, verifying the archive yourself (never `curl | sh`):

```sh
curl -fsS https://releases.herdr.dev/core/0.1.14/manifest.json -o manifest.json
python3 -c 'import json;t=json.load(open("manifest.json"))["targets"]["linux-x86_64"];print(t["url"]);print(t["sha256"])'
# download the printed URL, then:
echo "<sha256 from the manifest>  herdr-core.tar.gz" | sha256sum --check
tar -xzf herdr-core.tar.gz -C ~/.local/bin
```

Then either start a core yourself (`HC_SESSION=default herdr-core serve`, or `hc run --bg ...`) and
select `attach`, or let the Connector start a private one with `managed`:

```json
{
  "native": {
    "provider": "herdr-core",
    "herdr_core": { "session": "default", "mode": "managed" }
  }
}
```

`mode: "managed"` runs `herdr-core serve` from `native.runtime_bin_dirs` (or `PATH`) with a private
`XDG_RUNTIME_DIR`/`XDG_STATE_HOME`/`XDG_CONFIG_HOME`; rovloom never calls `hc`, never downloads or
updates core, and leaves the core and its terminals running when the Connector exits. Templates live
in `<config_home>/herdr-core/templates/*.md`; with `managed` the default config home is private and
empty, so set `native.herdr_core.config_home` to a directory where you keep templates.

Pair as usual (`rovloom connector --join …`). What the MCP client can do:

- reads: `server.status`, `template.list`, `terminal.get`, `terminal.list`, `terminal.read`
  (`lines` up to 1000), `terminal.wait`;
- input and lifecycle (`allow_terminal_execution` required): `terminal.send`, `terminal.keys`,
  `terminal.interrupt`, `terminal.put`, `terminal.kill`, `terminal.rm`, `terminal.keep`,
  `terminal.label`;
- start (`allow_terminal_execution` required): `terminal.run` (program or template) and
  `templates.list`;
- everything else stays closed: `machine.*`, `file.*`, `doc.set`, `server.stop/restart`,
  `terminal.attach`.

To follow status changes without polling `terminal.list`, long-poll `terminal.events`: it returns the
current snapshot plus up to `limit` events after `after_seq` (default `limit` 64, wait ≤30s). Feed the
returned `next_after_seq` back; `rebuilt:true` means the state was replaced (missed events or a core
restart) and older events are gone, `truncated:true` means the local buffer overflowed. It is a read:
`allow_terminal_execution` is not needed.

A template run looks like this (`argv[0]` is the template name; `template: true` makes rovloom check
it against `templates.list` first):

```json
{ "method": "terminal.run", "params": { "argv": ["reviewer", "Review src/x.rs"] , "template": true, "name": "review" } }
```

Then talk to it in turns: `terminal.send` with `wait: true` and an explicit `timeout` (≤60s) sends
one message and waits for that turn, and `terminal.read` with `lines` reads the reply. A turn that
ends leaves the agent in `done`, not `idle`; `if: "idle"` is therefore not a "ready for the next
message" condition. Core-level rejections such as `status_mismatch` are reported as
`not_dispatched` with a `reason`, so nothing was typed.

## 3. Start and pair

Pairing is one command. Start the Gateway, generate a per-device pairing code, then run the
displayed join command on the Connector machine — no prompts, approvals or verification codes.

**On the Gateway machine:**

```sh
rovloom gateway
```

Docker Gateway: `docker compose up -d` after initializing as in section 1. The Gateway can also
run unattended with `--non-interactive`; the management page stays available.

If you pair through the management page (recommended), create an administrator in another
terminal on the Gateway machine and save the password (default username `admin`):

```sh
rovloom admin create
```

Docker uses `docker compose run --rm gateway admin create`. Running `create` again re-issues
that administrator's password and invalidates old passwords and browser sessions.

**Generate a pairing code** — either way works:

- Management page: open `http://127.0.0.1:9445/`, sign in, go to **Pair a device** and click
  **Generate code**. The full join command appears with a copy button; unused codes can be
  revoked from the list.
- Terminal: run `rovloom gateway --issue-code` and it prints one join command at startup.

**On the Connector machine**, paste the join command:

```sh
rovloom connector --join ws://127.0.0.1:9443#MACHINE.CODE_ID.SECRET
```

That is the whole pairing: the Connector writes the Gateway address, scans the local
Herdr/Luvus installation, exchanges the code for device credentials in one request, and starts
running. On the first device it also prints the MCP URL and Bearer once. The device shows up in
the management page a few seconds later; the Gateway loads the new configuration while running.

If the pairing response is lost, retry the same join command promptly. The Gateway keeps
recent delivery results in memory for up to 10 minutes, including across its automatic
configuration reload. Restarting the Gateway clears this cache; use a fresh code then.

Codes are one per device: the first successful exchange consumes the code, and a used, revoked
or failed code cannot be exchanged again — generate a new one. Running the join command again
with a fresh code re-pairs this machine as a new device; a join command from a different
Gateway retires the previous local state (kept under `state/retired/`) and pairs there without
manual cleanup. Recovery after revocation is the same path: generate a new code and re-run the
join command. For a completely clean slate, run `rovloom connector --unpair`: all local pairing
state is retired and the Gateway address is cleared, after which any Gateway can be joined fresh.

**Get an MCP Bearer:** the join command prints it once for the first device. Afterwards open
**Connect MCP** in the Dashboard, enter a name and expiry, then click **Create token**.
Tokens stay in this list: use **Show**, **Copy**, or **Delete** whenever needed, including
after refreshing or restarting the Gateway. Dashboard tokens can access current and future
paired devices. Older hash-only tokens must be reissued if no original copy remains. The
administrator password is separate from the MCP Bearer.

Configure the MCP endpoint and `Authorization: Bearer <TOKEN>` in your AI client. For remote
access, replace a loopback hostname with the reachable Gateway address and enable MCP LAN
access as described below.

The **Devices** detail page can delete a device and disconnect it. Device deletion removes that
device's runtime bindings, pairing records and call content; reconnecting requires pairing again.

CLI remains available: `rovloom token list` and
`rovloom token create --principal my_client --like EXISTING_CALLER_ID`.
In Docker use `docker compose run --rm gateway token ...`.
New tokens are stored as readable values in the Gateway's private state directory so the
Dashboard can display them later; include that directory when backing up credentials.

### LAN access

The listener hostname is the only switch: `0.0.0.0` accepts any Host over plain HTTP on that listener,
`127.0.0.1` accepts only loopback addressing; there is no separate `lan` field. The Docker image sets
`ROVLOOM_CONTAINER=1`, so its first-startup configuration binds all three listeners to `0.0.0.0` by default;
access through the host IP still depends on the Compose port mappings. See [Docker deployment](DOCKER.md)
for port mapping examples.
The npm binary defaults to `0.0.0.0` on the MCP and device listeners and `127.0.0.1` on the management page;
to open the management page on the LAN, edit `~/.config/rovloom/gateway.json` after first setup.
Preserve the other fields and update the listener groups you need;
edit existing configuration directly:

```json
{
  "devices": {"hostname": "0.0.0.0", "port": 9443},
  "mcp": {"hostname": "0.0.0.0", "port": 9444},
  "management": {"enabled": true, "hostname": "0.0.0.0", "port": 9445}
}
```

This is a fragment; do not replace the complete file containing `schema_version`, `role` and `data`.
After restarting the Gateway, the Connector uses `ws://GATEWAY_IP:9443`, the browser opens
`http://GATEWAY_IP:9445/`, and the MCP client uses `http://GATEWAY_IP:9444/mcp`.
If only the Connector is remote, update only `devices` and keep the other listeners on loopback.

LAN access uses plain HTTP/WS. Use it on trusted networks with firewall restrictions, and put an
HTTPS/WSS reverse proxy in front of public access. For Docker, also check the container configuration
and Compose port mappings: MCP and management are published only on the host's loopback by default.
See [Docker deployment](DOCKER.md) and [network access](CONFIGURATION.md#network-access).

## 4. Connect your MCP client

Add a **Streamable HTTP** server in your AI client:

| Setting | Value |
|---|---|
| URL | `http://127.0.0.1:9444/mcp` (default) |
| Authorization header | `Bearer <the token saved in section 3>` |

For CLI pairing, use the Bearer printed by the Gateway; for web pairing, use the token issued with
`token create` above. Neither the pairing code nor the administrator password is the Bearer.
The Bearer expires after 30 days; renew it with `rovloom token renew` or `rovloom token rotate`.
Remote clients reach the MCP listener through its LAN address, your proxy or a tunnel.
Rovloom is not a stdio MCP server.

Then ask the client to list the machine's workspaces and Agents, and send an Agent a short message.
A call whose outcome is uncertain after a disconnect is reported as unknown and is never resent
automatically. Tool details are in the [MCP reference](protocol/MCP-HTTP.md).

The management page is at `http://127.0.0.1:9445/`. The default username is `admin`; use the password
printed during CLI pairing or `rovloom admin create`. It shows each device's connection and lets you
create pairing applications, rename, disconnect or revoke devices and disable providers.
See the [management page guide](GATEWAY-WEBUI.md).

## 5. Everyday tasks

| Task | How |
|---|---|
| Start again | Run `rovloom gateway --non-interactive` on the Gateway machine and `rovloom connector --non-interactive` on the Connector machine; saved pairing state is reused. For Docker Gateway, use `docker compose up -d`. |
| Add another device | Keep the Gateway running, generate a new pairing code on the management page (or `rovloom gateway --issue-code`), and run the displayed join command on the new device. Full Gateway tokens created in the dashboard, and their clones, follow current paired targets within device_scope. Legacy ordinary tokens and their clones retain their approved targets and actions; newly exposed methods need no token recreation or method-list update. |
| Credential lost or leaked | Delete the device on the management page (or simply) generate a new pairing code and run the join command on that machine; the local pairing state retires and the device re-pairs as a new identity. In-flight calls become unknown. |
| Moving to another Gateway | Stop that Connector and run the new Gateway's join command (previous state retires automatically); or run `rovloom connector --unpair` first for a clean slate. |
| Run at boot | `rovloom service install --role gateway` (or `connector`) — see [Boot services](SERVICE.md). |
| Validate configuration | `rovloom config check --role gateway` (or `connector`). |
| Tokens, backup, upgrades | [Operations guide](OPERATIONS.md) |

Each role keeps one configuration file, created on first run and never reset:
`~/.config/rovloom/gateway.json` and `~/.config/rovloom/connector.json`. Every option is in the
[configuration reference](CONFIGURATION.md).

## Troubleshooting

| Symptom | What to do |
|---|---|
| `configuration_required` / `pairing_required` | Finish the terminal prompts and approvals, or pair from the management page ([Pairing](CONFIGURATION.md#pairing)); a saved Gateway address alone does not pair the device. |
| `configuration_required` right after a join | The selected runtime is not on the Connector's search path. Install Herdr or Luvus (§2), confirm `herdr --version` / `luvus --version` works, then run the join command again with a fresh code. |
| Cannot connect / address in use | Check ports, the Gateway listener address and network reachability. |
| HTTP 401 | Check the `/mcp` URL, the Bearer and its expiry. |
| `native_state_path_too_long` | Choose a shorter `data.directory` before pairing (Unix socket path limit). |
| `invalid_device_credential` | Generate a new pairing code and run the join command again to re-pair this machine as a new device. |
| No Agent reply | Check the Agent's installation directory and model login; a ready Connector does not mean the model replied. |
| Setup interrupted with an uncertain outcome | Keep the existing data and ask your administrator; do not delete it and register again. |

Keep error codes when asking for help, and keep your Bearer secret.
