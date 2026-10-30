/**
 * herdr-core 作为第三种 provider 的中性端口描述：档位与保证都来自只读 spike 的实测结论，
 * 不继承 Herdr TUI 的方法表或保证强度。
 */
import type { ProviderDescriptor } from '../../runtime/provider-port.js'
import { HERDR_CORE_METHODS, HERDR_CORE_REVIEW } from './methods.js'

export const HERDR_CORE_PROVIDER_DESCRIPTOR: ProviderDescriptor = Object.freeze({
  kind: 'herdr-core',
  protocol_family: 'herdr-core-jsonrpc',
  methods: HERDR_CORE_METHODS,
  guarantees: Object.freeze({
    // 快照加 missed 重建当前状态，没有事件回放。
    event_recovery: 'snapshot_rebuild',
    // core 只有扁平终端，没有原生 incarnation fence。
    terminal_fence: 'unavailable',
    // `$/cancelRequest` 对 terminal.wait 无效。
    cancel: 'unavailable',
    // turn 会在崩溃后少算，不能宣称本轮完成。
    prompt_completion: 'unavailable'
  })
})

/** 本次审核对应的 core 版本与提交；升级后必须重新分类，不能沿用本表。 */
export const HERDR_CORE_DESCRIPTOR_REVISION = Object.freeze({
  version: HERDR_CORE_REVIEW.version,
  commit: HERDR_CORE_REVIEW.commit,
  methods: Object.keys(HERDR_CORE_METHODS).length
})
