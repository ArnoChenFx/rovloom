// 已配对 Connector 启动时的来源筛选与「配对时固化字段」提示：native 配置不再要求与配对时逐字相同。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configTemplate, type ConnectorConfig, type NativeProviderKind } from '../../src/cli/config.js'
import { changedPairedSettings, pinHerdrCoreInstance, selectNativeProviders } from '../../src/cli/native-selection.js'

const config = (native?: unknown) =>
  ({ ...configTemplate('connector'), ...(native ? { native } : {}) }) as ConnectorConfig
const all: readonly NativeProviderKind[] = ['luvus', 'herdr', 'herdr-core']

test('省略 native.provider：启动配对时的全部来源，没有任何提示', () => {
  for (const paired of [['luvus'], ['luvus', 'herdr'], all] as const) {
    assert.deepEqual(selectNativeProviders(config(), paired), { active: paired, idle: [], unpaired: [] })
  }
  // 写了别的 native 字段但没写 provider，同样不筛选。
  assert.deepEqual(selectNativeProviders(config({ runtime_bin_dirs: ['/opt/bin'] }), all).active, all)
})

test('native.provider 是对已配对来源的筛选：缩小范围不报错，未选中的不启动', () => {
  assert.deepEqual(selectNativeProviders(config({ provider: 'luvus' }), all, 'linux'), {
    active: ['luvus'],
    idle: ['herdr', 'herdr-core'],
    unpaired: []
  })
  assert.deepEqual(selectNativeProviders(config({ provider: 'luvus,herdr' }), all, 'linux').active, ['luvus', 'herdr'])
  // 显式写出与配对完全相同的集合：与省略等价。
  assert.deepEqual(selectNativeProviders(config({ provider: 'mixed' }), all, 'linux'), {
    active: all,
    idle: [],
    unpaired: []
  })
})

test('点名了从未配对的来源：不启动、启动时用设备凭据追加；mixed 也参与追加但按平台展开', () => {
  assert.deepEqual(selectNativeProviders(config({ provider: 'herdr-core' }), ['luvus', 'herdr'], 'linux'), {
    active: [],
    idle: ['luvus', 'herdr'],
    unpaired: ['herdr-core']
  })
  assert.deepEqual(selectNativeProviders(config({ provider: 'luvus,herdr-core' }), ['luvus'], 'linux'), {
    active: ['luvus'],
    idle: [],
    unpaired: ['herdr-core']
  })
  // 老 mixed 设备（只配对了 luvus+herdr）：mixed 在 Linux 展开为三种，缺的 herdr-core 要追加。
  assert.deepEqual(selectNativeProviders(config({ provider: 'mixed' }), ['luvus', 'herdr'], 'linux'), {
    active: ['luvus', 'herdr'],
    idle: [],
    unpaired: ['herdr-core']
  })
  // macOS/Windows 的 mixed 只有两项：不会去追加 herdr-core（core 只支持 Linux）。
  for (const platform of ['darwin', 'win32'] as const) {
    assert.deepEqual(selectNativeProviders(config({ provider: 'mixed' }), ['luvus', 'herdr'], platform), {
      active: ['luvus', 'herdr'],
      idle: [],
      unpaired: []
    })
  }
  // 省略 native.provider 时不追加任何来源。
  assert.deepEqual(selectNativeProviders(config({}), ['luvus'], 'linux'), {
    active: ['luvus'],
    idle: [],
    unpaired: []
  })
})

test('配对后改动的固化字段按生效值比较：省略与显式写默认值相同，只输出字段名', () => {
  const paired = { luvus: { mode: 'attach' }, runtime_bin_dirs: ['/a'] }
  // 省略 vs 显式默认值：不算改动。
  assert.deepEqual(changedPairedSettings('luvus', {}, config({ luvus: { mode: 'attach' } })), [])
  assert.deepEqual(changedPairedSettings('luvus', paired, config({ runtime_bin_dirs: ['/a'] })), [])
  // provider 本身不在固化字段里（它只是筛选）。
  assert.deepEqual(changedPairedSettings('luvus', {}, config({ provider: 'luvus' })), [])
  assert.deepEqual(changedPairedSettings('luvus', {}, config({ luvus: { mode: 'managed' } })), ['native.luvus.mode'])
  assert.deepEqual(changedPairedSettings('luvus', paired, config({ runtime_bin_dirs: ['/b'] })), [
    'native.runtime_bin_dirs'
  ])
  assert.deepEqual(
    changedPairedSettings(
      'herdr-core',
      { herdr_core: { session: 'a', mode: 'attach' } },
      config({ herdr_core: { session: 'b', mode: 'managed' } })
    ),
    ['native.herdr_core.session', 'native.herdr_core.mode']
  )
  // 取值不会出现在输出里（只有字段名）。
  assert.doesNotMatch(
    JSON.stringify(changedPairedSettings('herdr', {}, config({ herdr: { config_home: '/secret/place' } }))),
    /secret/u
  )
})

test('herdr-core 的 session/mode/config_home 沿用配对值，其余 native 设置保持当前配置', () => {
  const live = config({
    provider: 'herdr-core',
    agent_bin_dirs: ['/live/agents'],
    herdr_core: { session: 'changed', mode: 'managed', config_home: '/live/home' }
  })
  const pinned = pinHerdrCoreInstance(live, { herdr_core: { session: 'paired', mode: 'attach' } })
  assert.deepEqual(pinned.native?.herdr_core, { session: 'paired', mode: 'attach' })
  assert.deepEqual(pinned.native?.agent_bin_dirs, ['/live/agents'])
  assert.equal(pinned.native?.provider, 'herdr-core')
  // 配对时全是默认值：现在写的 herdr_core 整段被丢掉，回到默认（attach / default），不去拉起另一个 core。
  assert.equal(pinHerdrCoreInstance(live, {}).native?.herdr_core, undefined)
  // 输入不被修改。
  assert.equal(live.native?.herdr_core?.session, 'changed')
})
