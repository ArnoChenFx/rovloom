/** 用法：bun e2e/run.mjs <rovloom二进制> <herdr 0.9.5二进制> [场景名...]；每个场景一套全新隔离状态。 */
import assert from 'node:assert/strict'
import { createStack, environment } from './harness.mjs'
import { scenarios } from './scenarios.mjs'

const [binary, herdrBinary, ...only] = process.argv.slice(2)
assert(binary && herdrBinary, 'Usage: bun e2e/run.mjs /path/to/rovloom /path/to/herdr-0.9.5 [scenario...]')
const selected = scenarios.filter((item) => only.length === 0 || only.includes(item.name))
assert(selected.length > 0, 'e2e_no_scenario')
const results = []
for (const scenario of selected) {
  const started = Date.now()
  const stack = await createStack({
    binary,
    herdrBinary,
    methods: scenario.methods,
    connectorSettings: scenario.connectorSettings,
    attach: scenario.attach
  })
  const entry = { scenario: scenario.name }
  try {
    entry.evidence = await scenario.run(stack)
    entry.result = 'passed'
  } catch (error) {
    entry.result = 'failed'
    entry.error = String(error?.message ?? error)
    entry.diagnostics = stack.diagnostics()
  } finally {
    const problems = await stack.close()
    if (problems.length) {
      entry.cleanup = problems
      entry.result = 'failed'
    }
  }
  entry.seconds = Math.round((Date.now() - started) / 100) / 10
  results.push(entry)
  console.log(JSON.stringify(entry))
}
console.log(
  JSON.stringify({ environment: environment(binary), passed: results.every((item) => item.result === 'passed') })
)
process.exit(results.every((item) => item.result === 'passed') ? 0 : 1)
