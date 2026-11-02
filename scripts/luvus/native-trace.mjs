// 从原生采集记录重建进程、端点、终端与清理证据，审计 fixture 的语义一致性。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// 从原始 request/response 与进程记录重建最小门禁，不把 assertions.json 的自报当证据。
export function verifyNativeTrace(transcript, environment, artifacts) {
  const processRows = transcript.filter(/* 仅保留外部进程的执行证据。 */ (r) => r.kind === 'process')
  // 要求指定标签恰有一条进程记录，缺失或重复均使审计失败。
  const one = (label) => {
    const rows = processRows.filter(/* 查找指定采集步骤的进程记录。 */ (r) => r.label === label)
    assert.equal(rows.length, 1, `process evidence missing/duplicated: ${label}`)
    return rows[0]
  }
  // 按通道提取接收记录，并将线上的 JSON 解码为消息。
  const received = (channel) =>
    transcript
      .filter(/* 只保留该通道收到的消息。 */ (r) => r.kind === 'receive' && r.channel === channel)
      .map(/* 将原始消息解码，保留响应和事件内容。 */ (r) => JSON.parse(r.wire))
  // 返回与通道同名请求的唯一响应结果，拒绝缺失或重复证据。
  const result = (channel) => {
    const rows = received(channel).filter(/* 匹配该通道的主请求响应。 */ (r) => r.id === channel)
    assert.equal(rows.length, 1, `response evidence missing/duplicated: ${channel}`)
    return rows[0].result
  }
  // 检查通道首条响应的错误码是否符合预期拒绝原因。
  const errorCode = (channel, code) => assert.equal(received(channel)[0]?.error?.code, code, channel)
  // 要求指定发现步骤中没有仍在运行的会话。
  const noRunning = (label) =>
    assert(
      JSON.parse(one(label).stdout).sessions.every(/* 每个已发现会话都必须停止。 */ (s) => !s.running),
      label
    )
  const session = environment.session
  assert.equal(session, 'p0-issue3')
  assert.equal(environment.binary_sha256, '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9')
  assert.equal(environment.child_environment.LUVUS_HOME, '/fixture/issue3/state')
  assert.equal(environment.child_environment.HOME, '/fixture/issue3/child-home')
  const failures = new Set([
    'session-rpc-before-server',
    'proxy-no-final-lf',
    'proxy-malformed-json',
    'proxy-unknown-method',
    'native-wait-timeout'
  ])
  for (const row of processRows) {
    assert.deepEqual(row.argv.slice(0, 3), ['/fixture/bin/luvus', '--session', session])
    assert.equal(typeof row.stdout === 'string' || row.stdout_file === 'schema-bundle.json', true)
    assert.equal(typeof row.stderr, 'string')
    if (row.label === 'client-deadline') {
      assert.equal(row.timed_out, true)
      assert.equal(row.exit_code, -15)
      assert.equal(row.stdout, '')
    } else {
      assert.equal(row.timed_out, false, row.label)
      assert.equal(row.exit_code, failures.has(row.label) ? 1 : 0, row.label)
    }
  }
  assert.equal(one('binary-version').stdout, 'luvus 0.14.3\n')
  assert.match(one('server-status').stdout, /version\s+v0\.14\.3/)
  for (const label of ['discovery-before-host', 'discovery-after-host', 'discovery-after-cleanup']) {
    noRunning(label)
  }
  for (const label of ['session-rpc-before-server', 'proxy-no-final-lf', 'proxy-malformed-json']) {
    assert.equal(one(label).stdout, '')
    assert(one(label).stderr.length > 0, label)
  }
  assert.match(one('proxy-no-final-lf').stderr, /missing LF/)
  const host = JSON.parse(one('host-capabilities-before-server').stdout)
  const capabilities = JSON.parse(one('session-capabilities').stdout)
  assert.deepEqual(host, artifacts.host)
  assert.deepEqual(capabilities, artifacts.session)
  assert.equal(host.result.profile, 'host')
  const protocol = { major: 1, minor: 0, name: 'luvus-uhp' }
  assert.deepEqual(host.result.protocol, protocol)
  assert.deepEqual(capabilities.result.protocol, protocol)
  assert.equal(capabilities.result.session, session)
  assert.equal(JSON.parse(one('host-info-before-server').stdout).result.version, '0.14.3')
  assert(
    JSON.parse(one('host-session-list-before-server').stdout).result.sessions.every(
      /* 在服务启动前不得出现运行中的会话。 */ (s) => !s.running
    )
  )
  const ping = one('proxy-ping')
  assert.equal(ping.stdout.split('\n').length, 2)
  assert.equal(ping.stderr, '')
  assert.equal(result('direct-ping').version, '0.14.3')
  assert(
    transcript.some(/* 确认单次直连 ping 后服务端关闭连接。 */ (r) => r.kind === 'eof' && r.channel === 'direct-ping')
  )
  assert.equal(JSON.parse(one('proxy-two-requests').stdout).id, 'first')
  assert.equal(JSON.parse(one('proxy-unknown-method').stdout).error.code, 'invalid_request')
  assert.equal(JSON.parse(one('native-wait-timeout').stdout).error.code, 'timeout')

  const started = transcript.filter(/* 提取原生服务的启动记录。 */ (r) => r.kind === 'server_start')
  assert.equal(started.length, 1)
  assert.deepEqual(started[0].argv, ['/fixture/bin/luvus', '--session', session, 'server'])
  const running = processRows
    .filter(/* 仅检查服务启动阶段的发现结果。 */ (r) => r.label === 'discovery-startup')
    .flatMap(/* 合并各次发现返回的会话列表。 */ (r) => JSON.parse(r.stdout).sessions)
    .filter(/* 保留本次采集的运行中会话。 */ (s) => s.name === session && s.running)
  assert(running.length > 0, 'running endpoint was not discovered')
  const endpoint = running.at(-1).endpoint
  assert.equal(endpoint.transport, 'unix_socket')
  assert(endpoint.address.startsWith('/fixture/issue3/state/'))
  let validation
  let peer
  let socketIdentity
  let connections = 0
  for (const row of transcript) {
    if (row.kind === 'endpoint_validation') {
      validation = row
      const socket = row.components.at(-1)
      assert.equal(socket.path, endpoint.address)
      assert.equal(socket.uid, environment.uid)
      assert.equal(socket.mode, '0o600')
      assert(
        row.components.some(
          /* 确认受保护状态目录的所有者与权限均正确。 */ (c) =>
            c.path === '/fixture/issue3/state' && c.uid === environment.uid && c.mode === '0o700'
        )
      )
      for (const component of row.components.slice(0, -1)) {
        assert.equal(Number.parseInt(component.mode.slice(2), 8) & 0o022, 0)
        if (component.path.startsWith('/fixture/issue3')) {
          assert.equal(component.uid, environment.uid)
          assert.equal(component.mode, '0o700')
        }
      }
      assert.equal(row.identity.length, 3)
      if (socketIdentity) {
        assert.deepEqual(row.identity, socketIdentity)
      }
      socketIdentity = row.identity
    }
    if (row.kind === 'peer_credentials') {
      assert(validation, 'peer must follow endpoint validation')
      assert.equal(row.uid, environment.uid, 'peer uid')
      assert.equal(row.pid, started[0].pid, 'peer server pid')
      peer = row
      validation = undefined
      connections++
    }
    if (row.kind === 'send' && JSON.parse(row.wire).method) {
      assert.equal(peer?.channel, row.channel, 'request needs its own validated connection')
      peer = undefined
    }
  }
  assert(connections > 0)
  const identity = artifacts.identity
  const created = result('terminal-create')
  for (const key of ['server_generation', 'terminal_id', 'pane_id']) {
    assert.equal(created[key], identity[key])
  }
  assert.equal(identity.server_generation, capabilities.result.server_generation)
  assert.equal(created.dispatch, 'executed')
  assert.equal(created.restore, false)
  assert.deepEqual(result('terminal-inventory'), artifacts.inventory)
  assert(
    artifacts.inventory.terminals.some(
      /* 确认清单包含本次新建且非恢复的终端。 */ (t) => t.terminal_id === identity.terminal_id && !t.restore
    )
  )
  const before = result('snapshot-before-create')
  const after = result('snapshot-after-create')
  assert.equal(after.server_generation, identity.server_generation)
  // 在指定事件通道查找属于本次终端的首个同名事件。
  const matchingEvent = (channel, event) =>
    received(channel).find(
      /* 同时匹配事件类型和新建终端身份。 */ (r) => r.event === event && r.data.terminal_id === identity.terminal_id
    )
  const createdEvent = matchingEvent('events-primary', 'terminal.created')
  assert(before.event_sequence < createdEvent.sequence && createdEvent.sequence <= after.event_sequence)
  assert.deepEqual(matchingEvent('events-independent', 'terminal.created'), createdEvent)
  assert(
    after.workspaces.some(
      /* 查找包含目标终端的工作区。 */ (w) =>
        w.tabs.some(
          /* 查找包含目标终端的标签页。 */ (t) =>
            t.panes.some(/* 查找新建终端对应的窗格。 */ (p) => p.terminal_id === identity.terminal_id)
        )
    )
  )
  const eventChannels = new Map()
  for (const row of transcript.filter(/* 只检查接收消息中的事件序号。 */ (r) => r.kind === 'receive')) {
    const event = JSON.parse(row.wire)
    if (!event.event) {
      continue
    }
    const previous = eventChannels.get(row.channel) ?? 0
    assert(event.sequence > previous, 'native event sequence must increase within each channel')
    eventChannels.set(row.channel, event.sequence)
  }
  errorCode('control-stale-generation', 'stale_server')
  errorCode('control-wrong-terminal', 'stale_terminal')
  // 旧主采集未含 wrong-pane；必须核对独立原生补充采集，不能因主记录缺失而跳过拒绝证据。
  const stalePane = artifacts.stalePane
  assert(stalePane, 'stale-route evidence required')
  assert.equal(stalePane.source.capture_completed, true)
  assert.equal(stalePane.source.archive_sha256, '71c38aa6ce308cb71fe02746a8380034e2869b75d82c8c288edefd3b4935cc41')
  assert.equal(stalePane.binary_sha256, environment.binary_sha256)
  assert.equal(stalePane.schema_sha256, '00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6')
  assert.equal(stalePane.records.length, 2)
  const exchange = stalePane.records.map((row, index) => {
    assert.equal(row.kind, index === 0 ? 'send' : 'receive')
    assert.equal(row.channel, 'control-wrong-pane')
    assert(row.wire.endsWith('\n'), 'stale-route frame must end with LF')
    assert.equal(createHash('sha256').update(row.wire).digest('hex'), row.wire_sha256)
    return JSON.parse(row.wire)
  })
  const [wrongPaneRequest, wrongPaneResponse] = exchange
  assert.equal(wrongPaneRequest.method, 'terminal.backend.control')
  assert.equal(wrongPaneRequest.id, 'control-wrong-pane')
  assert.equal(wrongPaneResponse.id, wrongPaneRequest.id)
  assert.equal(wrongPaneRequest.params.server_generation, stalePane.terminal_identity.server_generation)
  assert.equal(wrongPaneRequest.params.terminal_id, stalePane.terminal_identity.terminal_id)
  assert.notEqual(wrongPaneRequest.params.pane_id, stalePane.terminal_identity.pane_id)
  assert.equal(wrongPaneResponse.error?.code, 'stale_route')
  if (transcript.some((row) => row.channel === 'control-wrong-pane')) {
    errorCode('control-wrong-pane', 'stale_route')
  }
  errorCode('control-lease-conflict', 'control_conflict')
  assert.equal(result('terminal-control').mode, 'control')
  assert.equal(result('terminal-observe').mode, 'observe')
  for (const channel of ['terminal-control', 'terminal-observe']) {
    for (const key of ['server_generation', 'terminal_id', 'pane_id']) {
      assert.equal(result(channel)[key], identity[key])
    }
  }
  assert.equal(
    received('terminal-control').find(/* 定位合法输入请求的确认响应。 */ (r) => r.id === 'input-1')?.result.dispatch,
    'queued'
  )
  assert(
    received('terminal-observe').some(
      /* 查找终端实际消费输入后输出的反转标记。 */ (r) => r.data?.text?.includes('CONSUMED:321cba-tupni-0p')
    )
  )
  assert.equal(
    received('terminal-control').find(/* 定位非法输入请求的拒绝响应。 */ (r) => r.id === 'input-invalid')?.error.code,
    'invalid_params'
  )
  assert(
    transcript.some(
      /* 确认控制流由客户端主动关闭。 */ (r) => r.kind === 'client_close' && r.channel === 'terminal-control'
    )
  )
  assert(
    transcript
      .filter(
        /* 仅保留控制租约重新申请通道的响应。 */ (r) =>
          r.kind === 'receive' && r.channel.startsWith('control-reacquire-')
      )
      .some(/* 重新申请至少一次应成功取得控制模式。 */ (r) => JSON.parse(r.wire).result?.mode === 'control')
  )
  for (const channel of ['validate-after-stream-close', 'validate-after-deadline']) {
    assert.equal(result(channel).state, 'alive')
  }
  assert.equal(result('terminal-close').dispatch, 'executed')
  const closed = matchingEvent('events-primary', 'terminal.closed')
  assert(closed.sequence > after.event_sequence)
  const replayRequest = JSON.parse(
    transcript.find(/* 定位事件重放的原始订阅请求。 */ (r) => r.kind === 'send' && r.channel === 'events-replay').wire
  )
  assert.equal(replayRequest.params.after_sequence, after.event_sequence)
  assert.deepEqual(matchingEvent('events-replay', 'terminal.closed'), closed)
  assert.equal(result('validate-after-terminal-close').state, 'gone')
  errorCode('input-after-close', 'stale_terminal')
  assert(
    transcript.some(/* 终端关闭后观察流应收到连接结束。 */ (r) => r.kind === 'eof' && r.channel === 'terminal-observe')
  )
  const exits = transcript.filter(/* 提取服务退出证据以核验唯一成功退出。 */ (r) => r.kind === 'server_exit')
  assert.equal(exits.length, 1)
  assert.equal(exits[0].exit_code, 0)
  assert.equal(
    transcript.some(/* 查找采集器显式报告的失败。 */ (r) => r.kind === 'collection_failure'),
    false
  )
  if (typeof environment.cleanup === 'object') {
    assert.deepEqual(environment.cleanup, {
      server_stopped: true,
      no_running_sessions: true,
      temporary_root_removed: true,
      errors: []
    })
    assert.deepEqual(
      transcript.find(/* 查找与环境清理摘要对应的记录。 */ (r) => r.kind === 'cleanup'),
      { kind: 'cleanup', ...environment.cleanup }
    )
  }
  return { connections, event_channels: eventChannels.size, lifecycle_reconstructed: true }
}
