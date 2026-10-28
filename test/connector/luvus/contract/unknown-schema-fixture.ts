// 提供纯合成的小型契约夹具，不声明正式 Luvus 来源或执行权限。

/** 构造未知原字节，覆盖完整 Worker 与两个 helper 的打包行为。 */
export function unknownSchemaBundle(): string {
  const base = 'https://luvus.dev/protocol/uhp/v1/'
  const protocol = { name: 'luvus-uhp', major: 1, minor: 0 }
  const documents: Record<string, Record<string, unknown>> = {}
  /** 每个完整根都显式登记并由同一对象建立 alias，不裁剪被测编译器的约束。 */
  function document(name: string, schema: Record<string, unknown>): Record<string, unknown> {
    const value = { $id: base + name, $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema }
    documents[value.$id] = value
    return value
  }
  const request = document('request.schema.json', {
    type: 'object',
    properties: { id: { type: 'string' }, method: { enum: ['synthetic.packaging'] }, params: { type: 'object' } },
    required: ['id', 'method'],
    allOf: [
      {
        if: { properties: { method: { const: 'synthetic.packaging' } } },
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema 条件关键字是纯数据，不是 Promise 接口。
        then: { properties: { params: { type: 'object' } } }
      }
    ]
  })
  const response = document('response.schema.json', {
    type: 'object',
    properties: {
      id: { type: 'string' },
      error: {
        type: 'object',
        properties: {
          code: { const: 'synthetic' },
          // 两个 Unicode 码点及对象 const 分别要求原 ucs2length/equal helper 实际工作。
          message: { type: 'string', minLength: 2, maxLength: 2 },
          data: { const: { preserved: true } }
        },
        required: ['code', 'message', 'data'],
        additionalProperties: false
      }
    },
    required: ['id', 'error'],
    additionalProperties: false
  })
  return JSON.stringify({
    protocol,
    documents,
    request,
    response,
    event: document('event.schema.json', { type: 'object' }),
    event_catalog: document('event-catalog.schema.json', {
      type: 'object',
      properties: { synthetic: { type: 'object' } }
    }),
    terminal: {
      protocol,
      documents: {},
      methods: {},
      request: document('schema/terminal/request.schema.json', { type: 'object' }),
      response: document('schema/terminal/response.schema.json', { type: 'object' }),
      event: document('schema/terminal/event.schema.json', { type: 'object' }),
      control_frame: document('schema/terminal/control-frame.schema.json', { type: 'object' })
    },
    access: { descriptor: document('access-descriptor.schema.json', { type: 'object' }) }
  })
}
