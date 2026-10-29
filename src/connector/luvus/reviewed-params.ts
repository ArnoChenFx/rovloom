/** 已审核的参数子集；与安装版原生 schema 分别标注来源。 */
import type { JsonObject } from '../../wire/types.js'

export const WAIT_OUTPUT_MATCH_BYTES = 4096
const panePattern = [
  '[1-9][0-9]{0,8}',
  '[1-3][0-9]{9}',
  '4[01][0-9]{8}',
  '42[0-8][0-9]{7}',
  '429[0-3][0-9]{6}',
  '4294[0-8][0-9]{5}',
  '42949[0-5][0-9]{4}',
  '429496[0-6][0-9]{3}',
  '4294967[01][0-9]{2}',
  '42949672[0-8][0-9]',
  '429496729[0-5]'
].join('|')

/** 每次返回独立数据；UTF-8 字节边界是显式扩展，不能用字符数冒充字节数。 */
export function luvusReviewedParams(method: string): JsonObject | undefined {
  if (method !== 'wait.output') {
    return undefined
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['pane', 'match'],
    properties: {
      pane: {
        type: 'string',
        pattern: '^(?:' + panePattern + ')$',
        description: 'Positive u32 pane ID, 1..4294967295.'
      },
      match: {
        type: 'string',
        minLength: 1,
        maxLength: WAIT_OUTPUT_MATCH_BYTES,
        pattern: '^[^\\u0000]+$',
        'x-maxUtf8Bytes': WAIT_OUTPUT_MATCH_BYTES,
        description: 'Literal substring, 1..4096 UTF-8 bytes, without NUL. maxLength counts characters, not bytes.'
      },
      timeout_s: { type: 'number', minimum: 0, maximum: 3600 }
    }
  }
}
