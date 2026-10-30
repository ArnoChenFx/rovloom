// 单文件用户开关只进入现有本机guard，不改变原生安装settings或Gateway配置。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'

test(
  'Connector终端开关在各平台默认开启，显式布尔值完整往返且不改变安装settings',
  /** 模板与实际parser共用同一默认值。 */ () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const base = configDocument(configTemplate('connector', platform))
      assert.equal(base.allow_terminal_execution, true)
      const { allow_terminal_execution: _omitted, ...without } = base
      const directory = platform === 'win32' ? 'C:\\native\\bin' : '/opt/native/bin'
      for (const enabled of [undefined, false, true]) {
        const document = {
          ...without,
          native: { agent_bin_dirs: [directory] },
          ...(enabled === undefined ? {} : { allow_terminal_execution: enabled })
        }
        const parsed = parseConfig(document, platform)
        assert.equal(parsed.role, 'connector')
        assert.equal(configDocument(parsed).allow_terminal_execution, enabled !== false)
        assert.deepEqual(configDocument(parsed).native, document.native)
        assert.deepEqual(parseConfig(configDocument(parsed), platform), parsed)
      }
      for (const value of ['true', 'false', 1, 0, null, {}, []]) {
        assert.throws(
          /** 不接受真值转换或另一层配置注入。 */ () =>
            parseConfig({ ...base, allow_terminal_execution: value }, platform)
        )
      }
      assert.throws(
        /** Gateway不能替Connector本机开启终端输入。 */ () =>
          parseConfig(
            { ...configDocument(configTemplate('gateway', platform)), allow_terminal_execution: true },
            platform
          )
      )
    }
  }
)
