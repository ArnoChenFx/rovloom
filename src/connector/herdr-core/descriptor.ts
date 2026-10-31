/**
 * herdr-core 作为第三种 provider 的中性端口描述：档位与保证都来自只读 spike 的实测结论，
 * 不继承 Herdr TUI 的方法表或保证强度。
 */
import type { ProviderDescriptor } from '../../runtime/provider-port.js'
import { HERDR_CORE_CLASSIFICATION_REVISION, HERDR_CORE_METHODS } from './methods.js'

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

/** 本仓库档位表的修订与方法数；改了档位或参数规则就要递增修订并重新配对。 */
export const HERDR_CORE_DESCRIPTOR_REVISION = Object.freeze({
  classification: HERDR_CORE_CLASSIFICATION_REVISION,
  methods: Object.keys(HERDR_CORE_METHODS).length
})
