// Exercise acceptance scripts with controlled missing evidence; synthetic failures never count as native acceptance.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { scenarios } from '../../e2e/scenarios.mjs'

function source(name) {
  return readFileSync(new URL('../../e2e/' + name, import.meta.url), 'utf8')
}

function fixtureStack({ alive = true, status = 'revoked', link = 'offline', machineError = false } = {}) {
  const client = {
    async close() {},
    async callTool() {
      return { isError: machineError, structuredContent: { data: { status, link } } }
    }
  }
  return {
    target: { machine_id: 'fixture_machine' },
    connector: { async stop() {} },
    gateway: { async stop() {} },
    async startGateway() {},
    startConnector() {
      return { alive }
    },
    async connect() {
      return client
    },
    async waitReady() {},
    async revokeOffline() {},
    async invoke() {
      return { submit_error: { gateway_error: { code: 'unavailable' } } }
    }
  }
}

test(
  'device-revoke requires a live Connector and explicit revoked/offline machine evidence',
  { timeout: 25_000 },
  async () => {
    const scenario = scenarios.find((row) => row.name === 'device-revoke')
    const evidence = await scenario.run(fixtureStack())
    assert.equal(evidence.connector, 'alive')
    for (const fault of [{ alive: false }, { status: 'active' }, { link: 'connected' }, { machineError: true }]) {
      await assert.rejects(scenario.run(fixtureStack(fault)), { name: 'AssertionError' })
    }
  }
)

test('unknown-outcome rejects both undispatched submission and undispatched settlement', async () => {
  for (const stage of ['submission', 'settlement']) {
    // The only signalled PID is this test's own disposable process.
    const child = spawn(process.execPath, ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const closed = once(child, 'close')
    const stack = fixtureStack()
    const client = {
      async callTool() {
        return { structuredContent: { data: { state: 'not_dispatched' } } }
      }
    }
    stack.connect = async () => client
    stack.connector.kill = async () => {}
    let invokes = 0
    stack.natives = () => [{ pid: child.pid }]
    stack.readResult = async () => ({ result: { snapshot: { workspaces: [] } } })
    stack.invoke = async () =>
      ++invokes === 1
        ? { state: 'responded' }
        : {
            state: stage === 'submission' ? 'not_dispatched' : 'dispatching'
          }
    try {
      await assert.rejects(
        scenarios.find((row) => row.name === 'unknown-outcome').run(stack),
        stage === 'submission' ? /not_dispatched/ : /scenario must reach uncertain dispatch/
      )
    } finally {
      child.kill('SIGCONT')
      child.kill('SIGKILL')
      await closed
    }
  }
})

test('scenario runner fails acceptance when teardown reports a failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-e2e-cleanup-'))
  try {
    writeFileSync(join(root, 'run.mjs'), source('run.mjs'))
    writeFileSync(
      join(root, 'scenarios.mjs'),
      "export const scenarios = [{ name: 'fixture', async run() { return {} } }]\n"
    )
    writeFileSync(
      join(root, 'harness.mjs'),
      `
      export function environment() { return {} }
      export async function createStack() {
        return { async close() { return JSON.parse(process.env.CLEANUP_PROBLEMS) } }
      }
    `
    )
    for (const problems of [[], ['synthetic cleanup failure']]) {
      const result = spawnSync(
        process.execPath,
        ['--no-env-file', join(root, 'run.mjs'), 'fixture-product', 'fixture-herdr'],
        {
          encoding: 'utf8',
          env: { ...process.env, CLEANUP_PROBLEMS: JSON.stringify(problems) }
        }
      )
      assert.equal(result.status, problems.length ? 1 : 0, result.stderr)
      const lines = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(lines.at(-1).passed, problems.length === 0)
      if (problems.length) {
        assert.deepEqual(lines[0].cleanup, problems)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two-host unavailable step rejects authentication and protocol tool errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-two-host-result-'))
  try {
    const sdk = join(root, 'node_modules/@modelcontextprotocol/sdk')
    mkdirSync(sdk, { recursive: true })
    writeFileSync(
      join(sdk, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: {
          './client/index.js': './client.js',
          './client/streamableHttp.js': './transport.js',
          './types.js': './types.js'
        }
      })
    )
    writeFileSync(
      join(sdk, 'client.js'),
      `
      export class Client {
        async connect() {}
        async close() {}
        async callTool({name}) {
          if (name === 'runtime_discover') return {structuredContent: {data: {items: [{method: 'ping', contract_ref: 'fixture'}]}}}
          if (process.env.TOOL_FAILURE === 'not_dispatched') return {structuredContent: {data: {state: 'not_dispatched'}}}
          return {isError: true, structuredContent: {gateway_error: {code: process.env.TOOL_FAILURE}}}
        }
      }
    `
    )
    writeFileSync(join(sdk, 'transport.js'), 'export class StreamableHTTPClientTransport {}\n')
    writeFileSync(join(sdk, 'types.js'), 'export const CallToolResultSchema = {}\n')
    writeFileSync(join(root, 'check.mjs'), source('two-host-check.mjs'))
    const config = join(root, 'mcp.json')
    writeFileSync(config, JSON.stringify({ targets: [{}], url: 'http://127.0.0.1/mcp', token: 'synthetic' }))
    for (const code of [
      'unavailable',
      'not_dispatched',
      'unauthenticated',
      'forbidden',
      'invalid_arguments',
      'internal_error'
    ]) {
      const result = spawnSync(process.execPath, ['--no-env-file', join(root, 'check.mjs'), 'unavailable'], {
        encoding: 'utf8',
        env: { ...process.env, MCP_CONFIG: config, TOOL_FAILURE: code }
      })
      assert.equal(result.status, ['unavailable', 'not_dispatched'].includes(code) ? 0 : 1, result.stderr)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
