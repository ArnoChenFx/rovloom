// 已审核子集的调用提示与固定字段诊断；不冒充安装版原生 JSON Schema，不返回请求值。
const help = {
  'agent.wait': {
    required: ['pane'],
    optional: ['status', 'statuses', 'timeout_s'],
    rules: [
      'Select a pane, not an agent target. Supply exactly one of status or statuses.',
      'statuses matches any listed state. timeout_s is seconds (0..3600). No wait flag is used here.'
    ],
    examples: [{ pane: '2', status: 'idle', timeout_s: 35 }]
  },
  'agent.prompt': {
    required: ['target', 'text'],
    optional: ['terminal_id', 'strict', 'wait', 'until', 'timeout_s'],
    rules: [
      'Select an agent target. until or timeout_s requires wait:true.',
      'timeout_s is seconds (0..3600). The runtime_call deadline must cover the requested wait and RPC overhead.',
      'submitted/queued does not prove the agent consumed the prompt or finished replying.'
    ],
    examples: [{ target: 'selected-agent', text: 'Hello', strict: true, wait: true, until: ['idle'], timeout_s: 120 }]
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
