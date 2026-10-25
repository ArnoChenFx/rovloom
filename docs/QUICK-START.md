# Rovloom Quick Start

**English** · [简体中文](QUICK-START-zh.md) · [Configuration reference](CONFIGURATION.md)

Rovloom has two roles:

- **Gateway** — the MCP entry point your AI client talks to.
- **Connector** — runs on each machine that has Herdr or Luvus and connects out to the Gateway.

Both roles can run on the same machine. The Gateway runs on Linux, macOS and Windows; the
Connector runs on Linux x64, macOS (x64, arm64) and Windows x64. On macOS and Windows it attaches to the Herdr or Luvus you already run.

## 1. Install

**Linux / macOS** (x64 or arm64; Linux needs glibc). No Bun, Node or root access required:

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

**Already have Bun (1.4.3 or newer)?** Rovloom is on the npm registry; install it globally, or run it
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
docker compose run --rm gateway config init gateway --container
```

Ports 9443, 9444 and 9445 must be free (the Compose file publishes them from a bridge network), and `config init gateway --container` prepares the container listeners on first setup. See
[Docker deployment](DOCKER.md) for volumes, backup and upgrades.

## 2. Prepare the Connector machine

Install [Herdr](https://github.com/herdrdev/herdr/releases/latest) and/or
[Luvus](https://github.com/RizRiyz/luvus/releases/latest), plus the Agent you want to use, and
sign in to your model provider. Rovloom installs none of these.

The Connector **attaches to the session you already run**, so remote calls act on your real
workspaces and Agent logins. It starts one in your own config directory only if none is running.
Programs are found through `PATH` (plus `/usr/bin:/bin`); for other locations see
[installation directories](CONFIGURATION.md#program-and-agent-installation-directories).

Luvus is the default. Before first pairing, choose Herdr explicitly (use `mixed` for both):

```sh
rovloom config init connector --provider herdr
```

This creates configuration without starting the Connector or asking for an address. Existing configuration is preserved; if it selects another provider, the command returns `config_exists` so you can review it before changing it.

## 3. Start and pair

Choose either flow below for first pairing. Both require a real terminal on the Connector machine
to confirm the Gateway address and local Herdr/Luvus installation. The default addresses assume
both roles run on the same machine; for separate machines, configure [LAN access](#lan-access) first.

### Option A: Start and pair entirely through the CLI

Open two real local terminals and keep them open:

| Gateway machine | Connector machine |
|---|---|
| `rovloom gateway` | `rovloom connector` |

Docker Gateway: run `docker compose run --rm --service-ports gateway` in the Compose directory instead (stop
any running Gateway first with `docker compose stop gateway`).

1. **Gateway terminal:** approve pairing to get a one-time code (valid for five minutes).
2. **Connector terminal:** enter the Gateway address (`ws://127.0.0.1:9443` on the same machine) and
   the code, and confirm you trust this Gateway.
3. **Connector terminal:** approve discovery of the Herdr/Luvus installation.
4. **Gateway terminal:** approve the displayed installation and its workspace/Agent access.
5. Save the **MCP URL and Bearer** the Gateway prints (and the admin password, shown once).
   Wait for `connector_ready`.

Both processes can keep running after pairing; continue to section 4 to configure your MCP client.
To move a Docker Gateway to the background, stop its foreground process with Ctrl-C and run
`docker compose up -d`. Keep the Connector running; pairing state is retained in the volumes.

### Option B: Start and pair through the management page

**On the Gateway machine:** initialize configuration and start without the terminal pairing prompts:

```sh
rovloom config init gateway
rovloom gateway --non-interactive
```

Skip `config init` when Gateway configuration already exists; preserve the existing file.
The last command stays in the foreground. `--non-interactive` disables only the Gateway's local
prompts; the management page remains available. First startup creates the state directories.
In **another terminal on the Gateway machine**, create an administrator:

```sh
rovloom admin create
```

Save the printed password; the default username is `admin`. Skip this command if you already have
working administrator credentials. Running `create` again replaces that administrator's password
and invalidates the old password and existing browser sessions.

For a Docker Gateway initialized in section 1, use instead:

```sh
docker compose up -d
docker compose run --rm gateway admin create
```

If you already started `rovloom gateway`, answer `n` to its pairing prompt. It keeps running;
create the administrator from another terminal and continue below.

1. Open `http://127.0.0.1:9445/` in your browser and sign in. For remote access, use the Gateway IP
   configured below or an SSH tunnel.
2. Enter a device name in the pairing section, keep the default policy `rovloom_setup_v1`, create
   an application and copy its application number. If you have a custom policy list, select an allowed reference.
3. On the **Connector machine**, with Herdr/Luvus ready, run:

   ```sh
   rovloom connector --claim
   ```

   Enter the Gateway address (`ws://127.0.0.1:9443` on the same machine or
   `ws://GATEWAY_IP:9443` on your LAN), the application number, and confirm trust in the Gateway.
4. Check that the code on the Connector terminal matches the code on the page; review and approve
   the claim on the page.
5. Approve local installation access in the Connector terminal. Wait until native activation is
   complete and the device is ready. The Gateway loads the new configuration while running;
   no installation approval is needed in its terminal.

**Get an MCP Bearer:** open **Connect MCP** in the Dashboard, enter a name and expiry,
then click **Create token**. Tokens stay in this list: use **Show**, **Copy**, or **Delete**
whenever needed, including after refreshing or restarting the Gateway. New Dashboard tokens
can access current and future paired devices. Older hash-only tokens must be reissued if
no original copy remains. The administrator password is separate from the MCP Bearer.

Configure the MCP endpoint and `Authorization: Bearer <TOKEN>` in your AI client. For remote
access, replace a loopback hostname with the reachable Gateway address and enable MCP LAN
access as described below.

The **Devices** detail page can delete a device and disconnect it. **Pair device** also lists
saved pairing records, which can be deleted. Deleting an unfinished pairing stops it;
deleting a completed pairing record keeps its device. Device deletion removes that device's
runtime bindings, pairing records and call content; reconnecting requires pairing again.

CLI remains available: `rovloom token list` and
`rovloom token create --principal my_client --like EXISTING_CALLER_ID`.
In Docker use `docker compose run --rm gateway token ...`.
New tokens are stored as readable values in the Gateway's private state directory so the
Dashboard can display them later; include that directory when backing up credentials.

### LAN access

Normal CLI initialization allows only loopback access on all three listeners. Skip this section for a same-machine setup.
Docker initialization with `config init gateway --container` enables `management.lan` by default;
access through the host IP still depends on the Compose port mappings. See [Docker deployment](DOCKER.md)
for older configuration migration and port mapping examples.
On first setup, run `rovloom config init gateway` on the Gateway machine, then edit
`~/.config/rovloom/gateway.json`. Preserve the other fields and update the listener groups you need;
edit existing configuration directly:

```json
{
  "devices": {"hostname": "0.0.0.0", "port": 9443},
  "mcp": {"hostname": "0.0.0.0", "port": 9444, "lan": true},
  "management": {"enabled": true, "hostname": "0.0.0.0", "port": 9445, "lan": true}
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
| Add another device | Keep the Gateway running, create an application on the management page, and run `rovloom connector --claim` on the new device. Deployments using terminal setup can also stop the Gateway and run `rovloom gateway --add-device`. The original MCP caller's access expands to the new device; tokens made with `rovloom token create --like` must be re-created. |
| Credential lost or leaked | Stop that Connector, run `rovloom gateway --repair-device`, then `rovloom connector --repair` on the device. Native setup and access are kept; in-flight calls become unknown. |
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
| Cannot connect / address in use | Check ports, the Gateway listener address and network reachability. |
| HTTP 401 | Check the `/mcp` URL, the Bearer and its expiry. |
| `native_state_path_too_long` | Choose a shorter `data.directory` before pairing (Unix socket path limit). |
| `invalid_device_credential` | Re-pair the same device with `--repair-device` / `--repair`. A revoked device cannot be re-paired. |
| No Agent reply | Check the Agent's installation directory and model login; a ready Connector does not mean the model replied. |
| Setup interrupted with an uncertain outcome | Keep the existing data and ask your administrator; do not delete it and register again. |

Keep error codes when asking for help, and keep your Bearer secret.
