// 已审核子集的调用提示与固定字段诊断；不冒充安装版原生 JSON Schema，不返回请求值。
const help = {
  'wait.output': {
    required: ['pane', 'match'],
    optional: ['timeout_s'],
    rules: [
      'Wait for a literal substring in the selected pane. match is non-empty text, at most 4096 UTF-8 bytes; it is not a regex.',
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
      'evidence:timeout with observed_state:null means no qualifying transition was observed; with observed_state:working or blocked it means the requested until state was not matched before the deadline. Neither proves the agent failed to reply.',
      'Prefer submitting without wait, then observing agent.read and pane.status. Use wait.output for an explicitly authorized literal output sentinel; old output and prompt echo can match, so verify the reply separately. Do not resend a submitted prompt on an observation timeout.',
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
const rules = ['required', 'object', 'required_true', 'one_of', 'range', 'invalid_value'] as const
type Rule = (typeof rules)[number]
export type LuvusParameterDiagnostic = Readonly<{
  method: Method
  issues: readonly Readonly<{ path: string; rule: Rule }>[]
}>

/** 每次返回独立数据；提示不改变 generic_params_only 或 conditional_branch 的原生事实。 */
export function luvusParameterHelp(method: string): Record<string, unknown> | undefined {
  return Object.hasOwn(help, method)
    ? { source: 'rovloom_reviewed_subset', ...JSON.parse(JSON.stringify(help[method as Method])) }
    : undefined
}

/** 只定位固定方法的已知字段和依赖关系，不复制未知键、参数值或原生/Ajv 错误文本。 */
export function luvusParameterDiagnostic(request: unknown): LuvusParameterDiagnostic | undefined {
  if (
    !request ||
    typeof request !== 'object' ||
    !('method' in request) ||
    typeof request.method !== 'string' ||
    !Object.hasOwn(help, request.method)
  ) {
    return undefined
  }
  const method = request.method as Method
  const issues: { path: string; rule: Rule }[] = []
  const params = 'params' in request ? request.params : undefined
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    issues.push({ path: '/params', rule: 'object' })
  } else {
    const values = params as Record<string, unknown>
    for (const key of help[method].required) {
      if (values[key] === undefined) {
        issues.push({ path: '/params/' + key, rule: 'required' })
      }
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
    if (
      method !== 'pane.run' &&
      values.timeout_s !== undefined &&
      (typeof values.timeout_s !== 'number' ||
        !Number.isFinite(values.timeout_s) ||
        values.timeout_s < 0 ||
        values.timeout_s > 3600)
    ) {
      issues.push({ path: '/params/timeout_s', rule: 'range' })
    }
  }
  return { method, issues }
}

/** MCP 只投影固定路径/规则与程序自带提示；服务即使误带额外字段也不能回显请求或异常正文。 */
export function publicLuvusParameterDiagnostic(value: LuvusParameterDiagnostic) {
  if (!Object.hasOwn(help, value.method)) {
    return undefined
  }
  const fields: readonly string[] = [...help[value.method].required, ...help[value.method].optional]
  const issues = value.issues
    .slice(0, 8)
    .filter(
      (issue) =>
        rules.includes(issue.rule) &&
        (issue.path === '/params' || fields.some((field) => issue.path === '/params/' + field))
    )
    .map((issue) => ({ path: issue.path, rule: issue.rule }))
  // 这里只投影已经拒绝的请求；无法安全定位时给出固定根路径，不复述未知字段或原生错误。
  if (issues.length === 0) {
    issues.push({ path: '/params', rule: 'invalid_value' })
  }
  return { issues, parameter_help: luvusParameterHelp(value.method) }
}
