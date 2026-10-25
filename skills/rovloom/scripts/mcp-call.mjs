#!/usr/bin/env node
/**
 * A minimal Rovloom caller with no MCP client library: plain fetch handles the Streamable HTTP handshake,
 * tool calls and result paging.
 *
 *   export ROVLOOM_MCP_URL='http://127.0.0.1:9444/mcp'
 *   export ROVLOOM_MCP_TOKEN='<bearer>'
 *   node skills/rovloom/scripts/mcp-call.mjs tools
 *   node skills/rovloom/scripts/mcp-call.mjs call machines_list '{}'
 *   node skills/rovloom/scripts/mcp-call.mjs read <result_id>
 *
 * The Bearer is read from the environment only, never from a command-line argument, so it stays out of shell
 * history and process listings.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const PROTOCOL_VERSION = '2025-11-25'
const MAX_PAGE_BYTES = 16_384

const url = process.env.ROVLOOM_MCP_URL
const token = process.env.ROVLOOM_MCP_TOKEN

/** Record the exit code instead of exiting immediately so the finally block can still close the session. */
let exitCode = 0

function fail(message, code = 2) {
  process.stderr.write(message + '\n')
  exitCode = code
  throw new Stop(message)
}

class Stop extends Error {}

/** A tool refusal: print the fixed gateway_error and finish with a non-zero status. */
function rejected(structured) {
  fail(JSON.stringify(structured, null, 2), 1)
}

/** Parse an SSE body into the JSON-RPC messages carried by its data events. */
function sseMessages(text) {
  const messages = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (data) {
      messages.push(JSON.parse(data))
    }
  }
  return messages
}

class Session {
  #id
  #next = 1

  /** Send one JSON-RPC message; a notification returns null, a request returns its reply. */
  async post(message) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(this.#id ? { 'mcp-session-id': this.#id, 'mcp-protocol-version': PROTOCOL_VERSION } : {})
      },
      body: JSON.stringify(message)
    })
    this.#id ??= response.headers.get('mcp-session-id') ?? undefined
    if (response.status === 202) {
      return null
    }
    const text = await response.text()
    if (!response.ok) {
      // The gateway returns only a fixed error body and never echoes parameters; report status and body as-is.
      fail(`HTTP ${response.status}: ${text.slice(0, 400)}`)
    }
    if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
      const replies = sseMessages(text)
      const reply = replies.find((item) => item.id === message.id)
      if (!reply) {
        fail('No reply for this request in the SSE response')
      }
      return reply
    }
    return JSON.parse(text)
  }

  /** Initialize the session, reporting the protocol error verbatim on failure. */
  async open() {
    const reply = await this.post({
      jsonrpc: '2.0',
      id: this.#next++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'rovloom-skill-cli', version: '1' }
      }
    })
    if (reply.error) {
      fail(`initialize failed: ${JSON.stringify(reply.error)}`)
    }
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return reply.result
  }

  async request(method, params) {
    const id = this.#next++
    const reply = await this.post({ jsonrpc: '2.0', id, method, params })
    if (reply.error) {
      fail(`${method} failed: ${JSON.stringify(reply.error)}`)
    }
    return reply.result
  }

  /** Aggregate the static tool catalog page by page so callers need not follow nextCursor themselves. */
  async tools() {
    const tools = []
    let cursor
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {})
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  async call(name, args) {
    return this.request('tools/call', { name, arguments: args })
  }

  /** Close the MCP session; this releases protocol resources only and never touches a submitted native call. */
  async close() {
    if (!this.#id) {
      return
    }
    await fetch(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': this.#id,
        'mcp-protocol-version': PROTOCOL_VERSION
      }
    }).catch(() => undefined)
  }
}

/** Print a tool result uniformly: refusals go to stderr with a non-zero exit, successes print only data. */
function print(result) {
  const structured = result.structuredContent ?? {}
  if (result.isError === true) {
    rejected(structured)
  }
  process.stdout.write(JSON.stringify(structured.data ?? structured, null, 2) + '\n')
  return structured.data
}

/** Read the whole result across cursors and verify its digest; print text only when all bytes are valid UTF-8. */
async function readResult(session, resultId, outPath) {
  const chunks = []
  let cursor
  let digest
  let total
  for (;;) {
    const result = await session.call('runtime_result_read', {
      result_id: resultId,
      max_bytes: MAX_PAGE_BYTES,
      ...(cursor ? { cursor } : {})
    })
    const structured = result.structuredContent ?? {}
    if (result.isError === true) {
      rejected(structured)
    }
    const page = structured.data
    chunks.push(Buffer.from(page.chunk, 'base64'))
    digest = page.sha256
    total = page.total_bytes
    if (page.eof) {
      break
    }
    if (!page.next_cursor) {
      fail('A result page says it is not finished but has no next_cursor')
    }
    cursor = page.next_cursor
  }
  const bytes = Buffer.concat(chunks)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== digest) {
    fail(`Result digest mismatch: expected ${digest}, got ${actual}`)
  }
  if (bytes.length !== total) {
    fail(`Result size mismatch: expected ${total} bytes, got ${bytes.length}`)
  }
  process.stderr.write(`Read ${bytes.length} bytes, sha256 ${actual}\n`)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = undefined
  }
  if (text !== undefined) {
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'))
    return
  }
  const target = outPath ?? 'rovloom-result.bin'
  writeFileSync(target, bytes)
  process.stderr.write(`Result is not valid UTF-8; wrote it to ${target}\n`)
}

const [command, ...rest] = process.argv.slice(2)
if (!url || !token) {
  process.stderr.write('ROVLOOM_MCP_URL and ROVLOOM_MCP_TOKEN are required\n')
  process.exit(2)
}

const session = new Session()
try {
  await session.open()
  if (command === 'tools') {
    for (const tool of await session.tools()) {
      process.stdout.write(`${tool.name}\t${tool.description ?? ''}\n`)
    }
  } else if (command === 'call') {
    const [name, raw] = rest
    if (!name) {
      fail('usage: call <tool> <json-args>')
    }
    let args
    try {
      args = raw ? JSON.parse(raw) : {}
    } catch {
      fail('Tool arguments must be valid JSON')
    }
    print(await session.call(name, args))
  } else if (command === 'read') {
    const [resultId, outPath] = rest
    if (!resultId) {
      fail('usage: read <result_id> [output-file]')
    }
    await readResult(session, resultId, outPath)
  } else {
    fail('usage: tools | call <tool> <json-args> | read <result_id> [output-file]')
  }
} catch (error) {
  // Stop is an already-reported failure; other errors get a fixed notice without echoing parameters or credentials.
  if (!(error instanceof Stop)) {
    process.stderr.write('Call failed: ' + (error?.message ?? 'unknown') + '\n')
    exitCode = 2
  }
} finally {
  await session.close()
}
process.exit(exitCode)
