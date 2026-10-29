// 已审核子集的调用提示与固定字段诊断；不冒充安装版原生 JSON Schema，不返回请求值。
import type { ParameterDiagnostic, ParameterIssueRule } from '../../mcp/diagnostic.js'
import { luvusReviewedFields, luvusReviewedIssues, luvusReviewedValidator } from './reviewed-params.js'
const sentinelAdvice =
  'Use wait.output when runtime_discover lists it for this target. If it is not listed, it is not exposed by this provider; do not probe runtime_call. Old output and prompt echo can match, so verify the reply separately.'
const sentinelUnavailable =
  'wait.output is not exposed for this target and is unavailable. Do not call it; continue observing agent.read and pane.status. Its presence in the native schema does not mean this provider implements it.'
const help = {
  'agent.start': {
    required: ['name', 'kind'],
    optional: ['pane', 'anchor', 'direction', 'timeout_s', 'args'],
    rules: [
      'name and kind must each match ^[a-z][a-z0-9_-]{0,31}$: 1 to 32 lowercase ASCII letters, digits, underscores or hyphens, starting with a letter. kind must also identify an installed agent.',
      'pane is optional. Omitting pane creates a new pane; anchor optionally selects the pane to split. To use an existing pane, supply pane. pane and anchor are mutually exclusive.',
      'direction is auto, right or down. timeout_s is seconds (0..3600), with a native default of 30 seconds; leave RPC overhead before the runtime_call deadline.',
      'Custom launch args require the local terminal-execution switch. A ready result means the agent was recognized as interactive, not that a prompt completed.'
    ],
    examples: [
      { name: 'worker', kind: 'pi' },
      { name: 'worker', kind: 'pi', pane: '2' },
      { name: 'worker', kind: 'pi', anchor: '2', direction: 'right' }
    ]
  },
  'wait.output': {
    required: ['pane', 'match'],
    optional: ['timeout_s'],
    rules: [
      'Wait for a literal substring in the selected pane. match is non-empty text, at most 4096 UTF-8 bytes; it is not a regex.',
      'Enforce the params_schema x-maxUtf8Bytes keyword. maxLength counts characters and alone cannot guarantee an executable request. Register the custom keyword before using a strict JSON Schema validator.',
      'The native runtime first checks recent output, so an existing marker can match immediately. Use a fresh per-execution marker when appropriate.',
      'timeout_s is seconds (0..3600). Set it explicitly and leave RPC overhead before the absolute runtime_call deadline.',
      'A native type:wait response with matched:false means the observation ended without a match; it does not prove a command stopped or failed. No stdout or exit code is returned.'
    ],
    examples: [{ pane: '2', match: 'unique_marker_for_this_execution', timeout_s: 35 }]
  },
  'agent.wait': {
    required: ['pane'],
    optional: ['status', 'statuses', 'timeout_s'],
    rules: [
      'Select a pane, not an agent target. Supply exactly one of status or statuses.',
      'statuses matches any listed state. timeout_s is seconds (0..3600). No wait flag is used here.',
      'This matches current state, including an old idle state. A state_source of no_positive_state_evidence is not evidence that a new prompt completed.'
    ],
    examples: [{ pane: '2', status: 'idle', timeout_s: 35 }]
  },
  'agent.prompt': {
    required: ['target', 'text'],
    optional: ['terminal_id', 'strict', 'wait', 'until', 'timeout_s'],
    rules: [
      'Select an agent target. until or timeout_s requires wait:true.',
      'timeout_s is seconds (0..3600). The runtime_call deadline must cover the requested wait and RPC overhead.',
      'wait:true requires a new working or blocked transition before matching until. A fast reply or missing positive state evidence can leave the wait unmatched.',
      'A working state already present when the wait is registered is its baseline, not a new transition. Even until:["working"] can time out without a later active transition; observed_state records a transition, not the current status snapshot.',
      'evidence:timeout with observed_state:null means no qualifying transition was observed; with observed_state:working or blocked it means the requested until state was not matched before the deadline. Neither proves the agent failed to reply.',
      'Prefer submitting without wait, then observing agent.read and pane.status. Do not resend a submitted prompt on an observation timeout.',
      sentinelAdvice,
      'For fast-completing tasks, use two phases: agent.prompt without wait, followed by agent.wait on the resolved pane and agent.read. agent.wait matches current state, so verify the reply belongs to this turn even when matched:true.',
      'submitted/queued does not prove the agent consumed the prompt or finished replying.'
    ],
    examples: [
      { target: 'selected-agent', text: 'Hello', strict: true },
      { target: 'selected-agent', text: 'Hello', strict: true, wait: true, until: ['idle'], timeout_s: 120 }
    ]
  },
  'pane.run': {
    required: ['pane', 'command'],
    optional: [],
    rules: [
      'Submit command text to the selected pane. No cwd, env or argv override is accepted.',
      'An ok result acknowledges submission; it does not contain command stdout, stderr or exit status. Read the pane separately.'
    ],
    examples: [{ pane: '2', command: 'printf hello' }]
  }
} as const

type Method = keyof typeof help
const rules: readonly ParameterIssueRule[] = [
  'required',
  'object',
  'required_true',
  'one_of',
  'range',
  'pattern',
  'invalid_value'
]
type Rule = ParameterIssueRule
export type LuvusParameterDiagnostic = Readonly<{ method: string; issues: ParameterDiagnostic['issues'] }>

/** 每次返回独立数据；提示不改变 generic_params_only 或 conditional_branch 的原生事实。 */
export function luvusParameterHelp(
  method: string,
  visibleMethods?: readonly string[]
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(help, method)) {
    return reviewedHelp(method)
  }
  const guide = { source: 'rovloom_reviewed_subset', ...JSON.parse(JSON.stringify(help[method as Method])) }
  if (method === 'agent.prompt' && visibleMethods && !visibleMethods.includes('wait.output')) {
    guide.rules = guide.rules.map((rule: string) => (rule === sentinelAdvice ? sentinelUnavailable : rule))
  }
  return guide
}

/** 未手写提示的已审核方法，必填、可选字段与允许取值都来自同一份已审核 schema。 */
function reviewedHelp(method: string): Record<string, unknown> | undefined {
  const fields = luvusReviewedFields(method)
  if (!fields) {
    return undefined
  }
  return {
    source: 'rovloom_reviewed_subset',
    required: fields.required,
    optional: fields.optional,
    ...(Object.keys(fields.values).length > 0 ? { allowed_values: fields.values } : {})
  }
}

/** 只定位已审核方法的已知字段和依赖关系，不复制未知键、参数值或原生/Ajv 错误文本。 */
export function luvusParameterDiagnostic(request: unknown): LuvusParameterDiagnostic | undefined {
  if (
    !request ||
    typeof request !== 'object' ||
    !('method' in request) ||
    typeof request.method !== 'string' ||
    (!Object.hasOwn(help, request.method) && !luvusReviewedValidator(request.method))
  ) {
    return undefined
  }
  const method = request.method
  const issues: { path: string; rule: Rule }[] = []
  const params = 'params' in request ? request.params : undefined
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    issues.push({ path: '/params', rule: 'object' })
  } else {
    // 必填、类型、枚举、范围与未知字段和执行校验来自同一份已审核 schema。
    const reviewed = luvusReviewedIssues(method, params)
    issues.push(...reviewed.primary)
    const values = params as Record<string, unknown>
    if (method === 'agent.start' && values.pane !== undefined && values.anchor !== undefined) {
      issues.push({ path: '/params/pane', rule: 'one_of' })
    }
    if (method === 'agent.wait' && (values.status === undefined) === (values.statuses === undefined)) {
      issues.push({ path: '/params/statuses', rule: 'one_of' })
    }
    if (
      method === 'agent.prompt' &&
      (values.until !== undefined || values.timeout_s !== undefined) &&
      values.wait !== true
    ) {
      issues.push({ path: '/params/wait', rule: 'required_true' })
    }
    // 根路径兜底只在没有任何字段级解释时出现，避免把未知字段或枚举与真实原因并列。
    if (issues.length === 0) {
      issues.push(...reviewed.secondary)
    }
  }
  const seen = new Set<string>()
  return {
    method,
    issues: issues.filter((issue) => {
      const key = issue.path + ' ' + issue.rule
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }
}

/** MCP 只投影固定路径/规则与程序自带提示；服务即使误带额外字段也不能回显请求或异常正文。 */
export function publicLuvusParameterDiagnostic(value: LuvusParameterDiagnostic): ParameterDiagnostic | undefined {
  const fields = luvusReviewedFields(value.method)
  if (!fields) {
    return undefined
  }
  const names = [...fields.required, ...fields.optional]
  const issues = value.issues
    .slice(0, 8)
    .filter(
      (issue) =>
        rules.includes(issue.rule) &&
        (issue.path === '/params' ||
          names.some((field) => issue.path === '/params/' + field || issue.path.startsWith('/params/' + field + '/')))
    )
    .map((issue) => ({ path: issue.path, rule: issue.rule }))
  // 这里只投影已经拒绝的请求；无法安全定位时给出固定根路径，不复述未知字段或原生错误。
  if (issues.length === 0) {
    issues.push({ path: '/params', rule: 'invalid_value' })
  }
  return { issues, parameter_help: luvusParameterHelp(value.method) }
}
