<p align="center">
  <img src="docs/assets/brand/rovloom-logo-panel.svg" alt="Rovloom — orange-red woven R with an ovloom wordmark" width="600">
</p>

<p align="center"><strong>English</strong> · <a href="README-zh.md">简体中文</a></p>

# Rovloom

Rovloom gives AI agents and bots a single MCP endpoint to work with the
[Herdr](https://github.com/herdrdev/herdr) and [Luvus](https://github.com/RizRiyz/luvus) sessions
running on all of your machines. A **Gateway** exposes the MCP interface; a **Connector** on each
machine connects out to it, so your workspaces and Agent logins stay where they are and no inbound
port is opened on the machines that run them.

## Features

- **Multi-device access.** Every device runs one Connector that dials out to a shared Gateway.
- **Explicit targets.** Each call names a device, runtime and session; nothing is chosen implicitly.
- **Native runtimes.** Herdr and Luvus keep their own contracts and capabilities. herdr-core is an opt-in provider (Linux, core 0.1.14) that exposes the core's own agent management surface: reads (with history), input, interrupt/kill/rm/keep/label, `terminal.run` (program or template), `templates.list` and a `terminal.events` long poll for status changes. `native.herdr_core.mode` is `attach` (default, uses a core you started) or `managed` (the Connector starts a private core with `herdr-core serve`, never via `hc`). Everything that types into a terminal or starts a program requires `allow_terminal_execution`; core-wide methods (`machine.*`, `file.*`, `server.stop/restart`) stay closed. See [ADR 0009](docs/adr/0009-herdr-core-provider.md) for the capability catalog and the per-method limits.
- **Two authorization controls.** Tokens select visible devices; each Connector controls direct
  terminal execution. Every exposed method on a visible device is available to its token.
- **Honest results.** A call whose outcome is uncertain after a disconnect is reported as unknown
  and is never resent automatically.
- **Management page.** Review devices and providers, rename, disconnect or revoke them, and issue
  or rotate MCP Bearer tokens from the CLI.

## How it works

AI Agents and CLIs talk to the Gateway over MCP. Each device runs one Connector with local provider
adapters, which can manage several runtime instances. Sessions in those runtimes run local Agents
such as Claude Code, Codex, Pi, OpenCode and Fx; the Agent software and logins stay on that device.

<p align="center">
  <a href="docs/assets/architecture/architecture.en.svg">
    <img src="docs/assets/architecture/architecture.en.png" alt="Rovloom architecture: MCP clients access a Gateway; one outbound Connector per device routes calls through provider adapters to local Luvus and Herdr runtimes and their session Agents, such as Claude Code, Codex, Pi, OpenCode and Fx." width="1200">
  </a>
</p>

Solid arrows show requests and returned results/events; dashed arrows show Connector-initiated outbound WSS. Click the image for the scalable SVG.

## Typical setup: two machines, one Agent

Your workstation runs Herdr (or Luvus) with the workspaces and Agent logins you use every day. A small
always-on host runs the Gateway. Your AI client reaches the Gateway over MCP and acts on the
workstation's real sessions.

1. On the Gateway host: `rovloom gateway`.
2. On the workstation: paste the join command the Gateway prints (`rovloom connector --join ws://…#code`).
3. Add the Gateway's MCP URL and Bearer to your AI client and ask it to list the workstation's workspaces.

## CLI language

CLI output (help, join messages, status hints) is English by default. Set `ROVLOOM_LANG=zh-CN`
to switch to Simplified Chinese; without it the CLI stays in English regardless of the system
locale (`LC_ALL`/`LANG` have no effect). Error and status codes (`config_valid`,
`pairing_required`, …) are stable identifiers and never change with the language. The management
page picks its language in the browser, independently of this setting.

## Install

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.sh | sh
```

Already have Bun (1.4.4 or newer)? `bun add -g rovloom` installs the npm package instead — no
bundled runtime to download — and `bunx rovloom` runs it without installing.

Windows PowerShell and the Docker Gateway are covered in the [Quick Start](docs/QUICK-START.md).

| | Linux | macOS | Windows |
|---|---|---|---|
| Gateway | x64, arm64 (glibc / musl) | x64, arm64 | x64, arm64 |
| Connector | x64 (glibc; musl without Luvus managed) | x64, arm64 | x64 |

The musl Linux binaries need the C++ runtime (`apk add libstdc++` on Alpine) and cannot run Luvus
managed native processes; see [Distribution](docs/DISTRIBUTION.md).

A Connector needs **Herdr**, **Luvus**, or an already running **herdr-core** on its machine; see
[Quick Start §2](docs/QUICK-START.md#2-prepare-the-connector-machine) for per-platform install commands.

Pairing a Connector needs a real local terminal.

## Documentation

- [Quick Start](docs/QUICK-START.md) · [Configuration](docs/CONFIGURATION.md) · [Docker](docs/DOCKER.md)
- [Operations guide](docs/OPERATIONS.md) · [Boot services](docs/SERVICE.md)
- [Architecture](docs/DESIGN.md) · [Protocols](docs/PROTOCOL.md)
- [Development](docs/DEVELOPMENT.md) · [Contributing](CONTRIBUTING.md)
- [Documentation index](docs/README.md)

## License

[Apache License 2.0](LICENSE)
