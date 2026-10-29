# Docker deployment

[中文](DOCKER-zh.md) · [Quick Start](QUICK-START.md)

The Docker setup runs the **Gateway**, including its management page and MCP service. Run the Luvus/Herdr Connector on the host that owns the native application (Linux x64, macOS or Windows x64).

## Supported platforms

The official image is `ghcr.io/arnochenfx/rovloom`. It is public and can be pulled anonymously. It supports native Linux rootful Docker Engine on `linux/amd64` and `linux/arm64`. The Compose file uses a bridge network and publishes the Gateway's three ports on the host. Rootless Engine and Docker Desktop are not covered by CI acceptance.

## Start a Gateway

Install Docker Engine and Docker Compose v2 on a Linux host. The Gateway image needs no Bun, Node, Luvus or Herdr.

Save the maintained Compose file in an empty directory and start it:

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

The image sets `ROVLOOM_CONTAINER=1`: on first startup the default entrypoint (`rovloom gateway`) automatically generates a configuration that binds all three listeners to `0.0.0.0`, so the separate `config init gateway --container` step is no longer needed (the command still works and is equivalent).

The image defaults to `ghcr.io/arnochenfx/rovloom:latest`. To pin a version, set `ROVLOOM_VERSION=<version>` in the Compose directory's `.env` before pulling. Two named volumes keep configuration and data, and `docker compose down` does not delete them. First startup creates `/home/rovloom/.config/rovloom/gateway.json`. The data directory is `/home/rovloom/.local/share/rovloom/gateway`.

Default local endpoints:

| Purpose | Address | First startup |
| --- | --- | --- |
| Management page | `http://127.0.0.1:9445/` | Empty page, no administrator yet |
| MCP | `http://127.0.0.1:9444/mcp` | Unauthenticated requests receive 401 |
| Connector device listener | `127.0.0.1:9443` | Pairing is still required |

`healthy` means the MCP authentication listener responds. It does not mean a device is paired, an administrator exists or an Agent is ready. The `pairing_required` log line means setup is pending.

`config init gateway --container` binds the three listeners to `0.0.0.0` inside the container, accepting management Host values received through the host IP or an HTTP proxy
and plain-HTTP MCP requests addressed to any host on `/mcp` (Bearer still required).
Since the container image sets `ROVLOOM_CONTAINER=1`, this is also what the default entrypoint (`rovloom gateway`)
generates on first startup automatically — no extra subcommand is needed.
Authentication and same-origin checks still apply. Existing configuration is preserved; an older configuration
with different listeners or management LAN settings returns `config_exists`. Use the editing procedure below to update it.
MCP and management APIs support reverse proxies without an external URL setting. Compose publishes:

- `9443` (Connector device channel) on all host interfaces, so Connectors on other machines can reach it. Put a TLS reverse proxy in front of anything outside a trusted network, and restrict it with the host firewall.
- `9444` (MCP) and `9445` (management page) **only on the host's loopback** (`127.0.0.1`). Remote MCP clients go through a reverse proxy on the host that forwards to `127.0.0.1:9444`, without additional address configuration (see [Network access](CONFIGURATION.md#network-access)). Use the SSH tunnel below for remote management access.

To open the management page directly through the host IP on a trusted LAN, change its Compose port mapping to,
for example, `"192.168.11.200:9445:9445"` (replace the IP with the host's LAN address), then run `docker compose up -d`.
Open `http://192.168.11.200:9445/`. Older configurations also need `management.hostname: "0.0.0.0"` and a Gateway restart;
updating the image does not change existing configuration. This endpoint uses plain HTTP; restrict it to trusted
networks with the host firewall.

## Management login and online pairing

The Gateway does not create an administrator automatically on its first background startup. After initializing the configuration above and waiting for the background Gateway to start successfully, run this in the same Compose directory:

```sh
docker compose run --rm gateway admin create
```

The default username is `admin`. The password is the random string printed to stdout, **once only**; save it.
This command runs the CLI through the image entrypoint using the same configuration and data volumes. It starts
no second Gateway and needs no `--service-ports`. The official image does not install a `rovloom` command on PATH;
use the command above for administration.

Open `http://127.0.0.1:9445/` in a browser on the Docker host and sign in with `admin` and the generated password.
For a browser on another machine, run an SSH tunnel on that machine, then open the same address:

```sh
ssh -N -L 9445:127.0.0.1:9445 USER@DOCKER_HOST
```

Replace `USER@DOCKER_HOST` with an SSH account and address for the Docker host. The default Compose file publishes the management port only on the host's loopback.

Check existing administrators with:

```sh
docker compose run --rm gateway admin list
```

Skip creation if you already have a working password. If it is lost, rerun `admin create` to issue a new one;
the previous password and existing browser sessions for that administrator stop working immediately, without
restarting the Gateway. The administrator password is for the management page and cannot be used as an MCP Bearer.

After signing in, generate a per-device pairing code on the **Pair a device** page and copy the displayed
join command. On the Connector host, paste it: `rovloom connector --join ws://<gateway>#<code>` — one command,
no prompts or approvals. See [Quick Start: Start and pair](QUICK-START.md#3-start-and-pair) for the full flow
and MCP Bearer issuance. The Gateway stays in the background throughout this flow.

## First pairing from a terminal

The background service has no interactive terminal. If you cannot use the management page, stop the service and print a join command from a foreground Gateway on the same volumes. Never run two Gateways on the same data, including `docker compose run` next to a running service:

```sh
docker compose stop gateway
docker compose run --rm --service-ports gateway gateway --issue-code
```

`--service-ports` is required: `docker compose run` does not publish the Compose ports by default, so without it the printed address is not reachable from the Connector host. Run the init command above before starting a fresh volume.

Copy the printed join command to the Connector host (Linux x64, macOS or Windows x64) and run it: one command, no prompts or approvals (see [Start and pair](QUICK-START.md#3-start-and-pair)). When the Connector logs `connector_transport ready provider_ready=true`, pairing is finished. Stop the foreground Gateway with Ctrl-C and run `docker compose up -d`; the Connector reconnects on its own with exponential backoff. Configuration and pairing stay in the volumes.

To add another device or re-pair a device later, generate a new pairing code on the management page and run the displayed join command on the target host. The background Gateway does not need to stop; see [Pairing](CONFIGURATION.md#pairing).

## Configure, stop and upgrade

The image runs as UID/GID `10001:10001` with a read-only root filesystem. The default volumes already have that owner. For bind mounts, use that UID, mode `0700` for the configuration directory and `0600` for the file. Do not use `chmod 777`.

Export the generated configuration to edit it:

```sh
docker compose cp gateway:/home/rovloom/.config/rovloom/gateway.json ./gateway.json
chmod 600 gateway.json
```

Keep the `data`, `mcp`, `devices` and `management` groups. Fields are listed in the [configuration reference](CONFIGURATION.md). After editing, replace the file as the container's user and restart:

```sh
docker compose exec -T gateway sh -c \
  'umask 077; cat > /home/rovloom/.config/rovloom/gateway.json.next && mv /home/rovloom/.config/rovloom/gateway.json.next /home/rovloom/.config/rovloom/gateway.json' \
  < gateway.json
docker compose restart gateway
```

If you change the MCP port, also set `ROVLOOM_MCP_PORT` in `.env` so the health check follows. The variable does not change the listener port. Keep the data directory inside its volume.

```sh
docker compose stop       # SIGTERM and graceful shutdown
docker compose start      # Reuse configuration and data
docker compose down       # Remove containers and networks; keep volumes
```

`docker compose down -v` deletes the volumes, including configuration and data. To upgrade, stop normally, back up the volumes, then run `docker compose pull && docker compose up -d`. `latest` always points to the newest stable release. `docker compose run --rm gateway --version` reports the actual image version.

## Where to run the Connector

Run the Connector on the host that runs Luvus/Herdr (Linux x64, macOS or Windows x64). It verifies the native binary and schema, process ownership, private file permissions, the Unix socket peer and the instance lifecycle. A container has different users, PIDs and paths, and mounting a host socket does not preserve those guarantees. The Compose file therefore has no Connector, no `/var/run/docker.sock` mount, and no `privileged`, host PID or extra capabilities.

## Image build

Images are built from source with the official Bun image (`oven/bun:1-slim`, following Bun 1.x updates and resolved once for both build and runtime stages) and published to GHCR by the container workflow after a successful product release. Maintainers: see [DISTRIBUTION](DISTRIBUTION.md).
