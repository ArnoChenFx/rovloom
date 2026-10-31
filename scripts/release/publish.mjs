/** 全矩阵资产校验后先组装草稿再公开，已存在的不同资产从不覆盖或删除。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assemble, checksumsName, manifestName, releaseContext, repository } from './metadata.mjs'
import { publishNpm } from './registry.mjs'
import { findRelease, githubClient, verifyRemoteTag } from './github.mjs'

/**
 * 按版本记录该版本真正需要告知用户的升级事项与变更要点；没有条目的版本不生成任何提示。
 * 写成按版本查表，避免某个版本的升级提示被后续所有版本沿用。
 */
const RELEASE_NOTES = Object.freeze({
  '0.6.7': {
    upgrade:
      'Remove `mcp.public_url` from existing Gateway configuration before upgrading. Keeping this removed field causes `config check` and Gateway startup to fail with `invalid_config`; the old value is not ignored. Set the proxy HTTPS `/mcp` address in the AI client.'
  },
  '0.6.8': {
    highlights: [
      'Luvus read-only `wait.output` sentinel waits, with prompt-wait evidence guidance in `runtime_describe`.',
      'Host handshake details (`host_profile`, Wire minor 2) and provider native version / contract status in `machines_get` and `providers_get`.'
    ],
    upgrade:
      'Existing 35-method Luvus grants keep their original scope: `wait.output` must be granted explicitly in the Gateway caller/local policies, the provider raw grant and the Connector method grants. Upgrading does not widen a paired device automatically; a new pairing includes it.'
  },
  '0.6.9': {
    highlights: [
      'MCP tokens can be narrowed to selected devices (`rovloom token scope`, `--no-devices`), configurable per token in the Dashboard.',
      'Stale provider contracts are rejected before a call is registered, and the host report carries the system-visible logical CPU count.',
      'The Dashboard sidebar shows the running product version.'
    ],
    upgrade:
      'Connectors through v0.6.8 report available parallelism in `host_profile.cpus`. Upgrade and reconnect the Connector to report the system-visible logical CPU count; the Gateway does not convert old reports. Device scope on a token is an optional registry field: leaving it unset keeps today’s visibility, and an older binary refuses a registry that contains it (`invalid_config`) instead of ignoring it.'
  },
  '0.7.0': {
    highlights: [
      'Provider authorization is now only the token device scope plus the Connector terminal-execution switch; per-method and per-action grants are gone, and the caller registry is rewritten to schema v2 without them.',
      'Luvus and Herdr share one control layout under `control/<provider>/` and one content-addressed schema store; existing Connectors migrate their old control records on first start without re-pairing.',
      'The Gateway reclaims unreferenced `managed/schema_<sha256>.json` on its own: hourly, after seven days of continuous non-reference, 32 files / 16 MiB per pass.',
      'The public Gateway only accepts a provider port that implements admission and evidence retention, so adding a provider no longer touches the shared wiring.'
    ],
    upgrade:
      'Upgrade Gateway and every Connector together. Connectors migrate their old control records (`native-setup.json`, `herdr-setup.json`, `control/luvus-claims.db`, `hr/control/claims.db`, root/owner records) to `control/<provider>/` on first start and keep the original SQLite ledgers, tokens, device credentials and pairing — no re-pairing is needed, and an active ledger holder makes the migration refuse rather than proceed. The caller registry is rewritten to schema v2, which drops per-method/action grants, `local_policy`, `gateway_policy` and the standalone result-delete permission; `runtime_response_discard` is now available to any token that can see the call, so narrow it with device scope if that matters. Old policy and raw-grant fields are still read for compatibility but grant nothing. Rollback requires stopping both ends and restoring the same pre-upgrade backup with the matching binaries: an older binary refuses a v2 registry and a policy-free configuration instead of ignoring them.'
  },
  '0.7.1': {
    highlights: [
      '`wait.output` now has a machine-readable parameter schema even though native coverage stays generic: required `pane`/`match`, a real u32 pane, no NUL, and `timeout_s` in 0..3600 seconds. Its 4096 limit is UTF-8 bytes via the `x-maxUtf8Bytes` keyword; `maxLength` alone counts characters.',
      '`runtime_discover` and `runtime_describe` return `subset_revision` next to `contract_ref`, so a client can cache a directory by the method set it actually sees without changing the approved native source identity.',
      'The Connector reports Linux cgroup CPU bandwidth as an optional fractional `cpu_quota` with a paired `cpu_quota_status` (limited / unlimited / unknown / partial / unsupported), so four visible CPUs with a half-core quota no longer look like four usable cores.'
    ],
    upgrade:
      '`cpu_quota` needs both ends on Wire minor 3 (`host_cpu_quota`, dependent on `host_profile`) and a reconnecting Connector: an older Gateway never receives the two new fields, and a report without them means an older Connector rather than no limit. Read `cpu_quota_status` before using the number — only `unlimited` proves the fully inspected visible hierarchy has no limit, `partial` keeps a known upper bound but may miss a tighter ancestor, and `null` is never proof of unlimited capacity. `params_schema_source` distinguishes `installed_native_schema` from `rovloom_reviewed_subset`; strict validators must register `x-maxUtf8Bytes` to enforce the byte limit. Existing pairings, tokens and ledgers are unchanged.'
  },
  '0.8.0': {
    highlights: [
      'The release now ships `linux-x64-musl` and `linux-arm64-musl` alongside the six glibc, macOS and Windows binaries. The glibc, macOS and Windows asset names and bytes are unchanged, so existing downloads and scripts keep working.',
      '`install.sh` picks the `-musl` asset on any Linux that cannot prove glibc through `getconf GNU_LIBC_VERSION`, so Alpine no longer fails with "Only glibc Linux binaries are available". Checksum verification and atomic replacement are unchanged.',
      'The musl binaries need `libstdc++` at runtime (Alpine: `apk add libstdc++`), and the installer says so after a musl install.'
    ],
    upgrade:
      'A musl build cannot drive Luvus managed native process control: musl 1.2.5 exports `poll`, `getsockopt` and `__errno_location` but not `pidfd_open` or `pidfd_send_signal`, so managed Luvus sessions fail closed with `owned_pidfd_unavailable`. Gateway, Herdr and Luvus attach work on musl. The glibc assets are unchanged and nothing about pairing, tokens or ledgers moves — download the `-musl` asset only if your Linux has no glibc.'
  },
  '0.8.1': {
    highlights: [
      'Parameter rejections explain themselves on both providers. A request refused before registration (`native_request_invalid`, always `not_dispatched`) now carries `details.issues` (fixed paths and rules, never your values or unknown field names) and `parameter_help`. Herdr derives them from the installed schema, the same source as `runtime_describe.params_schema`; Luvus now covers every ordinary method instead of five.',
      'Luvus `runtime_describe` publishes a Rovloom-reviewed `params_schema` (`params_schema_source: rovloom_reviewed_subset`) for the ordinary methods that the native schema only covers as `generic_params_only`. Execution validation, the published schema and the diagnostics come from one definition; the native `schema_status` is unchanged.',
      'The Gateway write lock is now backed by a kernel `flock` on Linux. A Gateway killed by OOM or power loss restarts on its own even when the new process reuses the old PID, as in a restarted container, and a live Gateway in another container that shares the data volume is never mistaken for a dead one.',
      'Transitive dependency advisories are fixed (`body-parser` 2.4.0, `fast-uri` 3.1.9; `bun audit` is clean), and the Docker first-pairing, wire protocol and e2e docs now describe the current flow.'
    ],
    upgrade:
      'Nothing to migrate: pairings, tokens and ledgers are unchanged. Stop the old Gateway before starting this one: a still-running pre-0.8.1 Gateway holds no kernel lock and is protected only by the previous PID check, so never run two Gateways on the same data. A lock written by 0.8.1 carries `kernel_lock`; where the filesystem cannot provide `flock` (and on macOS and Windows) the PID check applies as before. Luvus `subset_revision` changes because the reviewed definitions are now part of it, so clients that cache `(contract_ref, subset_revision)` refetch descriptions once.'
  },
  '0.8.2': {
    highlights: [
      'Luvus parameter validation now has a single definition. The hand-written per-method field checks (about 300 lines) are removed: execution validation, the published `runtime_describe.params_schema` and the rejection diagnostics all read the Rovloom-reviewed schema, so they can no longer drift apart. Compared with the hand-written checks it replaces, on all 36 ordinary methods and 162,300 generated parameter sets, no request that was refused is now accepted and none that was accepted is now refused.',
      'A method without a reviewed schema is refused with `luvus_operation_params_invalid` instead of being left to separate code. All 36 ordinary methods have one, so nothing changes today; a future method cannot ship unchecked.',
      'The e2e quickstart harness (test tooling, not part of the binary) now reclaims its private servers and work directory when it is interrupted, so repeated runs no longer leave processes and about 140 MB of state behind.'
    ],
    upgrade:
      'Nothing to migrate and no behaviour change is expected: pairings, tokens, ledgers and the published schemas are the same as in 0.8.1.'
  },
  '0.9.0': {
    highlights: [
      'The Connector `allow_terminal_execution` switch now defaults to on. When the key is omitted from `connector.json`, direct terminal input and caller-chosen launch commands are enabled; only the literal `false` turns them off. Strings, numbers, `null` and objects are still rejected, and `rovloom config template connector` now writes `true`.',
      'An unknown switch state (the Gateway has not received a report, or the Connector is disconnected) is still treated as off, and so is any caller that does not pass the state explicitly. Every place that reads the switch now resolves the omitted value through one function, so the catalog the Gateway shows and the final check before a native write cannot disagree.'
    ],
    upgrade:
      'A `connector.json` written by an earlier Rovloom (`config template`, first-run setup or pairing) already contains `allow_terminal_execution` explicitly, so its choice is kept and nothing changes. Only a hand-written file that omits the key turns the switch on after the upgrade; callers whose token covers that device can then type into its terminals and choose launch commands. To keep the old behaviour, add `"allow_terminal_execution": false` to that file and restart the Connector. Pairings, tokens and ledgers are unchanged.'
  },
  '0.10.0': {
    highlights: [
      'herdr-core is a third runtime (Linux only). Set `native.provider` to `herdr-core` (`native.herdr_core.mode`: `attach` to a core you already run, or `managed` to let the Connector start a private one; Rovloom never uses `hc`, and never downloads, updates or stops core), pair as usual, and the catalog offers 16 methods: reading (`server.status`, `terminal.get`, `terminal.list`, `terminal.read`, `terminal.wait`, `templates.list`, and `terminal.events`, a long poll for status changes), input and lifecycle (`terminal.send` with `wait`, `terminal.keys`, `terminal.interrupt`, `terminal.put`, `terminal.kill`, `terminal.rm`, `terminal.keep`, `terminal.label`) and launch (`terminal.run`, a program or a core template). Input and launch methods follow `allow_terminal_execution`.',
      "Every write to a core terminal first checks the terminal's identity (core id, creation time and address) and refuses input to a terminal that is waiting for a person. A core's explicit refusal is reported as not dispatched with a fixed reason; a lost connection or timeout is an unknown outcome and is never replayed. After a core restart the Connector attaches again on its own.",
      'Rovloom puts no limit on the core version or protocol generation. A core works if its published contract contains every method Rovloom has reviewed: methods a newer core adds are not offered, and a result that no longer matches the contract is refused instead of passed through. Tested against core 0.1.14 and 0.1.15.',
      '`native.provider` also accepts `luvus,herdr`, `luvus,herdr-core` and `herdr,herdr-core`. `mixed` now means every provider the platform supports: Luvus, Herdr and herdr-core on Linux, Luvus and Herdr on macOS and Windows (herdr-core is Linux only).'
    ],
    upgrade:
      'Devices already paired with `mixed` (Luvus and Herdr) keep starting with those two and do not need to pair again. A new pairing with `mixed` on Linux also needs herdr-core installed and running; use `luvus,herdr` to get the old pair. Upgrading herdr-core itself replaces its binary, and a device paired with the old binary fails closed (`herdr_core_installation_changed`) until it is paired again with a fresh code. Nothing changes for Luvus or Herdr only setups: pairings, tokens and ledgers are unchanged.'
  },
  '0.10.1': {
    highlights: [
      'A paired device can add a provider it was not paired with, without a new pairing code. Name it in `native.provider` (one kind, a pair, or `mixed`) and restart the Connector: it prepares the provider locally, registers it with the Gateway using its device credential (`POST /pairing/providers`) and uses it from that start. Providers added in one start are registered together. It only adds: an existing provider is never changed or replaced, and a failure prints `native_provider_append_failed: <kind> <code>` while the paired providers keep starting.',
      '`native.provider` is no longer compared with the value from pairing at startup, which made any edit fail with `configuration_required`. After pairing it only filters the paired providers. The settings that bind a device to a native instance or binary (modes, state and config directories, binary and agent directories, the herdr-core session) keep their paired values; changing one prints `native_settings_kept: <names>`.',
      'herdr-core offers 24 methods. New: `machine.exec`, `file.read`, `file.write`, `file.edit`, `doc.get`, `doc.set`, `server.restart`, `server.stop`, and a `parent` for `terminal.run`. They follow `allow_terminal_execution` like the other terminal methods. `machine.*`, `terminal.attach` and `events.subscribe` stay closed, and `runtime_describe` lists them in `blocked_methods` with the reason.',
      '`rovloom connector --join` now names the provider it could not prepare, and the check that no Connector is running before pairing state is retired also covers herdr-core.'
    ],
    upgrade:
      'Upgrade the Gateway and the Connectors together: this release adds dispatch refusal codes and the `/pairing/providers` endpoint, which an older Gateway cannot serve. Nothing to migrate: pairings, tokens and ledgers are unchanged, and a device paired with herdr-core on 0.10.0 keeps working without pairing again. A Linux device paired as `mixed` before 0.10 gets herdr-core added at its next start if a core is reachable; with `allow_terminal_execution` on by default, callers whose token covers that device can then run commands and read and write files through it. Set `native.provider` to `luvus,herdr` to avoid that. Known limitation: if you narrow `native.provider` so the Connector no longer starts a provider that the Gateway still lists, a call to that provider returns `outcome_unknown` and makes the device reconnect once; its other providers recover on their own within about a second.'
  },
  '0.10.2': {
    highlights: [
      'A refused herdr-core call now says why. A request with bad parameters is refused before it is registered: `native_request_invalid` with `details.issues` (fixed paths and rules, no request values) and `parameter_help`, always `not_dispatched`, and no call is recorded. A call refused later (for example when the Gateway and the Connector are different versions) carries a `reason` in the call view instead of a bare `not_dispatched`. Omitting `params` is the same as `params: {}`.',
      'herdr-core control methods (`terminal.send`, `keys`, `interrupt`, `kill`, `rm`, `keep`, `label`, `put`) no longer need `core_id` and `created_ms`: give them to reject a reused address or a replaced core, omit them to act on the terminal under that address or name now. `terminal` (and `parent` of `terminal.run`) may be a terminal name; the Connector resolves it to an address before writing, and `machine/<id>` is still refused. `server.stop` and `server.restart` still require `core_id`.',
      '`runtime_describe` for herdr-core now matches what is enforced: the tiers are catalog labels and `allow_terminal_execution` is the only boundary, waiting calls return `connector_accepted` first and are finished with `runtime_call_get`, `status` and `turn` in a `send` reply are a snapshot taken at send time, and `terminal.run` with `rm` and `wait` returns no output.'
    ],
    upgrade:
      'Upgrade the Gateway and the Connectors together. A new Gateway with an older Connector still works, but a control call that omits `core_id`/`created_ms` or uses a terminal name makes the older Connector drop and reconnect (about one second) and the call ends `outcome_unknown`; nothing is written to the core. Nothing to migrate: pairings, tokens and ledgers are unchanged, and devices paired with herdr-core on 0.10.0 or 0.10.1 keep working without pairing again.'
  }
})

/** 生成公开版本、该版本的升级提示与变更要点，固定标记用于阻止借用不属于此契约的已有 Release。 */
export function releaseBody(context) {
  const notes = RELEASE_NOTES[context.version]
  const sections = []
  if (notes?.highlights?.length) {
    sections.push(notes.highlights.map(/** 每条要点独占一行。 */ (line) => `- ${line}`).join('\n'))
  }
  if (notes?.upgrade) {
    sections.push(`**Upgrade note:** ${notes.upgrade}`)
  }
  const head = `Rovloom ${context.version}\n\nCommit: ${context.commit}\n\n`
  const body = sections.length ? sections.join('\n\n') + '\n\n' : ''
  return `${head}${body}Binaries are not publisher-signed or notarized. Verify release-manifest.json and SHA256SUMS.\n\nWith Bun installed you can also run the npm package from this release: \`bunx --package <url of rovloom-${context.version}.tgz> rovloom --version\`.\n\n<!-- rovloom-release:1 ${context.tag} ${context.commit} -->`
}

/** 在每次恢复和公开前核对资产集合、长度和 GitHub 存储端摘要；不允许同名覆盖。 */
function verifyAssets(actual, expected, complete) {
  assert(Array.isArray(actual) && actual.length <= expected.size, 'Unexpected release assets')
  const seen = new Set()
  for (const asset of actual) {
    assert(!seen.has(asset.name), 'Duplicate release asset')
    seen.add(asset.name)
    const wanted = expected.get(asset.name)
    assert(wanted, 'Unknown release asset; refusing to overwrite')
    assert.equal(asset.state, 'uploaded', 'Incomplete remote asset; inspect draft before retry')
    assert.equal(asset.size, wanted.size, 'Remote asset size differs; refusing to overwrite')
    assert.equal(asset.digest, `sha256:${wanted.sha256}`, 'Remote asset digest differs; refusing to overwrite')
  }
  if (complete) {
    assert.equal(seen.size, expected.size, 'Release assets are incomplete')
  }
  return seen
}

/** 仅在完整组装及产品收据一致后允许写操作；可恢复同字节草稿，完整已发版本只读成功。 */
export async function publish(context, bundle, api) {
  const files = new Map()
  for (const asset of bundle.manifest.assets) {
    files.set(asset.name, { ...asset, path: bundle.files.get(asset.name) })
  }
  if (bundle.npm) {
    files.set(bundle.npm.name, { ...bundle.npm })
  }
  for (const [name, contents] of [
    [manifestName, bundle.manifestBytes],
    [checksumsName, bundle.checksumsBytes]
  ]) {
    const bytes = Buffer.from(contents)
    files.set(name, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
  }
  await verifyRemoteTag(api, context)
  let release = await findRelease(api, context.tag)
  const body = releaseBody(context)
  const prerelease = context.version.includes('-')
  if (!release) {
    release = await api(`/repos/${repository}/releases`, {
      method: 'POST',
      json: {
        tag_name: context.tag,
        target_commitish: context.commit,
        name: context.tag,
        body,
        draft: true,
        prerelease
      }
    })
  }
  assert.equal(release.tag_name, context.tag)
  // 已存在 tag 时 GitHub 忽略 target_commitish；提交身份由远端 tag、说明和资产合同校验。
  assert.equal(release.body, body, 'Existing release does not belong to this contract')
  assert.equal(release.prerelease, prerelease)
  assert(Number.isSafeInteger(release.id) && release.id > 0)
  const path = `/repos/${repository}/releases/${release.id}`
  const assetsPath = `${path}/assets?per_page=100`
  const actual = await api(assetsPath)
  const present = verifyAssets(actual, files, !release.draft)
  if (!release.draft) {
    return { status: 'already-published', tag: context.tag, commit: context.commit }
  }
  for (const [name, file] of files) {
    if (present.has(name)) {
      continue
    }
    const bytes = file.bytes ?? readFileSync(file.path)
    assert.equal(bytes.length, file.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, 'Local asset changed')
    await api(`${path}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', bytes })
  }
  verifyAssets(await api(assetsPath), files, true)
  await verifyRemoteTag(api, context)
  // GitHub 按语义版本选择稳定 latest，避免后补旧 tag 强行成为最新；预发布永不设为 latest。
  const published = await api(path, {
    method: 'PATCH',
    json: { draft: false, make_latest: prerelease ? 'false' : 'legacy' }
  })
  assert.equal(published.draft, false)
  assert.equal(published.tag_name, context.tag)
  return { status: 'published', tag: context.tag, commit: context.commit }
}

/** GitHub Release 公开且字节齐全后，把同一 tag 的 tarball 发布到 npm 注册表；失败时 Release 已公开，重跑走只读路径后重试。 */
export async function publishReleaseAndNpm(context, bundle, api, env = process.env, run = undefined) {
  const release = await publish(context, bundle, api)
  if (!bundle.npm) {
    return release
  }
  return { ...release, npm: await publishNpm(bundle.npm.path, env, run) }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 4, 'Usage: bun scripts/release/publish.mjs /staged-platforms /staged-npm')
  const context = releaseContext()
  const bundle = assemble(context, resolve(process.argv[2]), resolve(process.argv[3]))
  console.log(JSON.stringify(await publishReleaseAndNpm(context, bundle, githubClient(process.env.GITHUB_TOKEN))))
}
