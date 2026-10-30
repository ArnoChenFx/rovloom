// 用纯平台参数验证Windows模板根因，不伪装在Linux执行Windows文件权限或产品产物。
import { configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configTemplate, herdrMode, luvusMode, parseConfig, selectedNativeProviders } from '../../src/cli/config.js'

test(
  '双角色模板在各平台生成本机规范绝对占位路径并经过同一严格解析',
  /* 独立于当前OS覆盖两种路径语义；Windows实际产物仍由原生CI smoke执行。 */ () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const role of ['gateway', 'connector'] as const) {
        const template = configTemplate(role, platform)
        assert.equal(
          template.state_dir,
          platform === 'win32' ? `C:\\absolute\\protected\\rovloom\\${role}` : `/absolute/protected/rovloom/${role}`
        )
        assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(configDocument(template))), platform), template)
        assert(Object.isFrozen(template))
        assert(
          !Object.keys(template).some(
            /* 模板不得因平台差异引入秘密或身份字段。 */ (key) => /secret|token|principal/.test(key)
          )
        )
      }
    }
  }
)

test(
  '原生业务安装目录是规范路径数组，拒绝argv/env、终端开关和PATH风格的字符串列表',
  /* 这些字段进入实际首次发现和固定Agent PATH，不能把JSON扩成任意进程配置。 */ () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const directory = platform === 'win32' ? 'C:\\rovloom\\bin' : '/opt/rovloom/bin'
      const value = {
        ...configDocument(configTemplate('connector', platform)),
        native: { runtime_bin_dirs: [directory], agent_bin_dirs: [directory] }
      }
      const config = parseConfig(value, platform)
      assert.equal(config.role, 'connector')
      assert.deepEqual(configDocument(config).native, value.native)
      for (const native of [
        { binary: directory },
        { argv: [] },
        { env: {} },
        { allow_terminal_execution: true },
        { agent_bin_dirs: [directory + (platform === 'win32' ? ';' : ':') + directory] },
        { agent_bin_dirs: directory + (platform === 'win32' ? ';' : ':') + directory },
        { agent_bin_dirs: directory },
        { agent_bin_dirs: [] },
        { agent_bin_dirs: [directory, directory] },
        { agent_bin_dirs: Array.from({ length: 17 }, (_, index) => directory + index) },
        { runtime_bin_dirs: true },
        { runtime_bin_dirs: [directory, 7] },
        { agent_bin_dirs: ['~/.local/bin'] },
        { agent_bin_dirs: ['relative/bin'] }
      ]) {
        assert.throws(
          /* 未声明的能力或多目录PATH输入均在角色parser前置拒绝。 */ () => parseConfig({ ...value, native }, platform)
        )
      }
    }
  }
)

test(
  '首次native选择只接受程序定义的单一来源与固定组合，省略时保留原Luvus路径',
  /* 业务选择不能变成动态模块、路径、空列表或任意provider注册接口。 */ () => {
    const value = configDocument(configTemplate('connector'))
    assert.deepEqual(selectedNativeProviders(parseConfig(value) as import('../../src/cli/config.js').ConnectorConfig), [
      'luvus'
    ])
    // 旧值逐字按原样解析，含义不变；新增的两个组合值只是并列取值。
    for (const [provider, kinds] of [
      ['luvus', ['luvus']],
      ['herdr', ['herdr']],
      ['herdr-core', ['herdr-core']],
      ['mixed', ['luvus', 'herdr']],
      ['luvus,herdr-core', ['luvus', 'herdr-core']],
      ['herdr,herdr-core', ['herdr', 'herdr-core']]
    ] as const) {
      const selected = parseConfig({
        ...value,
        native: { provider }
      }) as import('../../src/cli/config.js').ConnectorConfig
      assert.deepEqual(selectedNativeProviders(selected), kinds)
      assert.deepEqual(configDocument(selected).native, { provider })
    }
    for (const provider of [
      '',
      'custom',
      '/bin/herdr',
      ['luvus', 'herdr'],
      {},
      null,
      1,
      // 顺序与分隔符是固定表，不按分隔符猜测。
      'herdr-core,luvus',
      'luvus, herdr-core',
      'luvus,herdr,herdr-core',
      'luvus,luvus'
    ]) {
      assert.throws(/* 无效选择在任何配对或原生进程之前拒绝。 */ () => parseConfig({ ...value, native: { provider } }))
    }
  }
)

test(
  'Windows模板修复不放宽真实路径规范性，拒绝drive相对路径、根目录及混合分隔符',
  /* 负例直接使用生产parseConfig的Windows路径分支，不绕过规范化相等检查。 */ () => {
    const windows = configTemplate('gateway', 'win32')
    for (const state_dir of [
      'C:relative',
      'C:\\',
      '/',
      '/absolute/protected/rovloom/gateway',
      'C:/absolute/protected/rovloom/gateway',
      'C:\\absolute\\..\\gateway',
      'C:\\absolute\\\\gateway',
      'C:\\absolute\\gateway\n'
    ]) {
      assert.throws(
        /* 路径仍须在目标平台绝对、非根且已规范化；模板不能成为放宽校验的例外。 */ () =>
          parseConfig({ ...configDocument(windows), data: { directory: state_dir } }, 'win32')
      )
    }
    assert.throws(
      /* 跨平台模板必须明确重新生成，不能把Windows路径用于POSIX。 */ () => parseConfig(configDocument(windows), 'linux')
    )
    assert.throws(
      /* POSIX模板不能靠忽略分隔符规范性在Windows上通过。 */ () =>
        parseConfig(configDocument(configTemplate('gateway', 'linux')), 'win32')
    )
  }
)

test(
  'native.herdr 只接受 attach/managed 与规范绝对的 config_home，默认附着',
  /* 运行方式决定信任模型，必须是明确枚举；路径沿用与其它安装目录相同的规范绝对规则。 */ () => {
    const base = configDocument(configTemplate('connector', 'linux'))
    const parse = (native: unknown) => parseConfig({ ...base, native }, 'linux')
    assert.equal(herdrMode(parse({}) as never), 'attach')
    assert.equal(herdrMode(parse({ herdr: { mode: 'managed' } }) as never), 'managed')
    const configured = parse({ provider: 'herdr', herdr: { mode: 'attach', config_home: '/home/u/.config' } })
    assert.equal(
      (configured as { native?: { herdr?: { config_home?: string } } }).native?.herdr?.config_home,
      '/home/u/.config'
    )
    for (const herdr of [
      { mode: 'shared' },
      { mode: true },
      { config_home: 'relative/dir' },
      { config_home: '/home/u/../x' },
      { config_home: ['/a'] },
      { extra: 1 },
      'attach'
    ]) {
      assert.throws(() => parse({ herdr }), { code: 'invalid_config' })
    }
  }
)

test(
  'native.luvus 只接受 attach/managed 与规范绝对的 state_root，默认附着',
  /* 与 Herdr 同一信任模型选择；state_root 指向用户自己的 LUVUS_HOME。 */ () => {
    const base = configDocument(configTemplate('connector', 'linux'))
    const parse = (native: unknown) => parseConfig({ ...base, native }, 'linux')
    assert.equal(luvusMode(parse({}) as never), 'attach')
    assert.equal(luvusMode(parse({ luvus: { mode: 'managed' } }) as never), 'managed')
    const configured = parse({ luvus: { mode: 'attach', state_root: '/home/u/.luvus' } })
    assert.equal(
      (configured as { native?: { luvus?: { state_root?: string } } }).native?.luvus?.state_root,
      '/home/u/.luvus'
    )
    for (const luvus of [
      { mode: 'shared' },
      { state_root: 'relative' },
      { state_root: '/home/u/../x' },
      { state_root: ['/a'] },
      { extra: 1 },
      'attach'
    ]) {
      assert.throws(() => parse({ luvus }), { code: 'invalid_config' })
    }
  }
)
