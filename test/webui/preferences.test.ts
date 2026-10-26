/** 验证双语词典完整性与非敏感偏好边界；纯测试不建立浏览器身份或管理服务。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalizer, messages, type MessageKey } from '../../src/webui/i18n.js'
import {
  browserLanguage,
  createUiPreferences,
  LANGUAGE_KEY,
  THEME_KEY,
  type PreferenceHost,
  type UiPreferences
} from '../../src/webui/preferences.js'

/** 构造隔离浏览器偏好来源，记录访问键与系统监听资源。 */
function fixture() {
  let languages = ['zh-CN']
  let dark = false
  const storage = new Map<string, string>()
  const reads: string[] = []
  const writes: [string, string][] = []
  const changes: UiPreferences[] = []
  let listener: () => void = /* 订阅前的系统变化没有消费者。 */ () => {}
  let cleaned = 0
  const host: PreferenceHost = {
    languages: /* 返回当前隔离浏览器语言。 */ () => languages,
    dark: /* 返回当前隔离系统主题。 */ () => dark,
    read: /* 记录每次读取，确认不访问身份或其它应用键。 */ (key) => {
      reads.push(key)
      return storage.get(key) ?? null
    },
    write: /* 记录固定枚举，不写用户数据。 */ (key, value) => {
      writes.push([key, value])
      storage.set(key, value)
    },
    subscribe: /* 提供可观察的系统监听清理。 */ (changed) => {
      listener = changed
      return /* 幂等清理由控制器保证。 */ () => {
        cleaned++
      }
    }
  }
  const preferences = createUiPreferences(/* 收集有效的展示状态变化。 */ (state) => changes.push(state), host)
  return {
    host,
    storage,
    reads,
    writes,
    changes,
    preferences,
    /** 模拟系统语言与主题同时变化，手动偏好保持独立。 */
    system(nextLanguages: string[], nextDark: boolean) {
      languages = nextLanguages
      dark = nextDark
      listener()
    },
    /** 读取已释放监听数，不接触真实 window。 */
    cleaned: () => cleaned
  }
}

test(
  '两语词典键与插值完全覆盖，每项文案有可格式化的非空文本',
  /** 编译期映射类型之外，运行时检查漏键、多键和翻译占位符漂移。 */ () => {
    const chineseKeys = Object.keys(messages['zh-CN']).sort()
    assert.deepEqual(Object.keys(messages.en).sort(), chineseKeys)
    assert(chineseKeys.length > 100)
    for (const key of chineseKeys as MessageKey[]) {
      const placeholders = [...messages['zh-CN'][key].matchAll(/\{([a-zA-Z]+)\}/gu)]
        .map(/* 比较每个词典的完整插值名。 */ (match) => match[1]!)
        .sort()
      assert.deepEqual(
        [...messages.en[key].matchAll(/\{([a-zA-Z]+)\}/gu)]
          .map(/* 英文不能丢失设备值或时间占位符。 */ (match) => match[1]!)
          .sort(),
        placeholders,
        key
      )
      const values = Object.fromEntries(
        placeholders.map(/* 协议值只作为文本原样保留。 */ (name) => [name, 'device/method_<literal>'])
      )
      for (const language of ['zh-CN', 'en'] as const) {
        assert(messages[language][key].trim().length > 0, key)
        const value = createLocalizer(language).t(key, values)
        assert(!/\{[a-zA-Z]+\}/u.test(value), key)
        assert.equal(value.includes('device/method_<literal>'), placeholders.length > 0)
      }
    }
    assert.throws(
      /* 漏掉必需插值时失败，避免静默显示残缺状态。 */ () => createLocalizer('en').t('device.connectionUnknown'),
      /webui_translation_argument_missing/u
    )
  }
)

test(
  '日期按浏览器时区展示且自带偏移标识，写死 UTC 的标签已移除',
  /** 时间戳只换展示时区，不引入浏览器墙钟作为观测。 */ () => {
    const zh = createLocalizer('zh-CN')
    const en = createLocalizer('en')
    const time = Date.UTC(2026, 9, 19, 3, 4, 5)
    assert.notEqual(zh.timestamp(time), en.timestamp(time))
    assert.equal(zh.timestamp(null), '尚无可信观测')
    assert.equal(en.timestamp(null), 'No trusted observation')
    // 同一时刻用同一组选项在本机默认时区渲染，证明展示没有固定成 UTC。
    const localFormatter = (language: string) =>
      new Intl.DateTimeFormat(language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'shortOffset',
        hourCycle: 'h23'
      })
    assert.equal(en.timestamp(time), localFormatter('en').format(time))
    assert.equal(zh.timestamp(time), localFormatter('zh-CN').format(time))
    // 偏移标识来自实际时区，而不是写死的“UTC”。
    assert.match(en.timestamp(time), /(?:GMT|UTC)/u)
    assert.match(zh.timestamp(time), /(?:GMT|UTC)/u)
    // 两个真实时区的渲染必须彼此不同，也不同于 UTC 渲染。
    assert.equal(createLocalizer('en', 'UTC').timestamp(time), 'Oct 19, 2026, 03:04:05 GMT+0')
    assert.equal(createLocalizer('en', 'Asia/Tokyo').timestamp(time), 'Oct 19, 2026, 12:04:05 GMT+9')
    assert.equal(createLocalizer('en', 'America/Los_Angeles').timestamp(time), 'Oct 18, 2026, 20:04:05 GMT-7')
    assert.equal(createLocalizer('zh-CN', 'Asia/Tokyo').timestamp(time), '2026年10月19日 GMT+9 12:04:05')
    for (const key of ['manage.expires', 'manage.observed'] as const) {
      assert(!messages['zh-CN'][key].includes('UTC'), key)
      assert(!messages.en[key].includes('UTC'), key)
    }
    assert.equal(en.reason('heartbeat_timeout'), 'Heartbeat timed out (heartbeat_timeout)')
  }
)

test(
  '相对年龄按量级进位到分/时/天/月/年，未来时点只按零年龄展示',
  /** 单位只由服务时点与单调经过时间决定，不从浏览器墙钟取“现在”。 */ () => {
    const zh = createLocalizer('zh-CN')
    const en = createLocalizer('en')
    const time = Date.UTC(2026, 9, 19, 3, 4, 5)
    const second = 1_000
    const minute = 60 * second
    const hour = 60 * minute
    const day = 24 * hour
    assert.equal(en.age(time, time + 5 * second), '5 seconds ago')
    assert.match(zh.age(time, time + 5 * second), /^5秒(?:钟)?前$/u)
    assert.equal(en.age(time, time + 59 * second), '59 seconds ago')
    assert.equal(en.age(time, time + minute), '1 minute ago')
    assert.match(zh.age(time, time + minute), /^1分钟前$/u)
    assert.equal(en.age(time, time + 59 * minute), '59 minutes ago')
    assert.equal(en.age(time, time + hour), '1 hour ago')
    assert.match(zh.age(time, time + hour), /^1小时前$/u)
    // 截图中累加过的 3,665 秒必须显示为 1 小时前。
    assert.equal(en.age(time, time + 3_665 * second), '1 hour ago')
    assert.equal(en.age(time, time + 23 * hour), '23 hours ago')
    assert.equal(en.age(time, time + day), '1 day ago')
    assert.match(zh.age(time, time + 2 * day), /^2天前$/u)
    assert.equal(en.age(time, time + 29 * day), '29 days ago')
    assert.equal(en.age(time, time + 30 * day), '1 month ago')
    assert.match(zh.age(time, time + 70 * day), /^2个月前$/u)
    assert.equal(en.age(time, time + 364 * day), '11 months ago')
    assert.equal(en.age(time, time + 365 * day), '1 year ago')
    assert.match(zh.age(time, time + 800 * day), /^2年前$/u)
    assert.equal(en.age(time + second, time), '0 seconds ago')
    assert.equal(en.age(null, time), 'No trusted heartbeat')
    assert.equal(zh.age(null, time), '尚无可信心跳')
  }
)

test(
  '浏览器支持语言按优先级选择，中文变体与未知语言有明确回退',
  /** 不从设备名、时区、IP或身份猜测用户语言。 */ () => {
    assert.equal(browserLanguage(['fr-FR', 'zh-TW', 'en-US']), 'zh-CN')
    assert.equal(browserLanguage(['en-GB', 'zh-CN']), 'en')
    assert.equal(browserLanguage(['ZH-hant']), 'zh-CN')
    assert.equal(browserLanguage([]), 'en')
    assert.equal(browserLanguage(['fr-FR']), 'en')
  }
)

test(
  '默认跟随浏览器及系统，手选偏好不被系统变化覆盖',
  /** 系统变更与手选仅通知展示，不重读或写入任何管理上下文。 */ () => {
    const f = fixture()
    assert.deepEqual(f.reads, [LANGUAGE_KEY, THEME_KEY])
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.preferences.state(), {
      languageChoice: 'system',
      themeChoice: 'system',
      language: 'zh-CN',
      theme: 'light'
    })
    assert(Object.isFrozen(f.preferences.state()))
    f.system(['en-US'], true)
    assert.equal(f.preferences.state().language, 'en')
    assert.equal(f.preferences.state().theme, 'dark')
    f.preferences.setLanguage('zh-CN')
    f.preferences.setTheme('light')
    const changes = f.changes.length
    f.system(['en-GB'], true)
    assert.equal(f.changes.length, changes)
    assert.equal(f.preferences.state().language, 'zh-CN')
    assert.equal(f.preferences.state().theme, 'light')
    f.preferences.setLanguage('system')
    f.preferences.setTheme('system')
    assert.equal(f.preferences.state().language, 'en')
    assert.equal(f.preferences.state().theme, 'dark')
    f.preferences.dispose()
    f.preferences.dispose()
    const count = f.changes.length
    f.system(['zh-CN'], false)
    f.preferences.setTheme('dark')
    assert.equal(f.changes.length, count)
    assert.equal(f.cleaned(), 1)
  }
)

test(
  '只记住language/theme枚举，非法输入不持久化，重新加载恢复手选',
  /** 两个固定键以外的合成敏感数据既不读取也不写入。 */ () => {
    const f = fixture()
    f.storage.set('other.token', 'SYNTHETIC_DO_NOT_READ')
    f.preferences.setLanguage('en')
    f.preferences.setTheme('dark')
    f.preferences.setLanguage('principal_id=admin')
    f.preferences.setTheme('url(secret)')
    assert.deepEqual(f.writes, [
      [LANGUAGE_KEY, 'en'],
      [THEME_KEY, 'dark']
    ])
    assert.equal(f.storage.get('other.token'), 'SYNTHETIC_DO_NOT_READ')
    const restored = createUiPreferences(
      /* 加载偏好不发送任何通知。 */ () => assert.fail('unexpected preference change'),
      f.host
    )
    assert.deepEqual(restored.state(), { languageChoice: 'en', themeChoice: 'dark', language: 'en', theme: 'dark' })
    assert(f.reads.every(/* 所有访问只能是这两项偏好。 */ (key) => key === LANGUAGE_KEY || key === THEME_KEY))
    restored.dispose()
    f.preferences.dispose()
  }
)

test(
  '非法或不可用storage安全回退，保存失败仍保留本页手选',
  /** 读写异常不得中断页面或借用sessionStorage等替代身份存储。 */ () => {
    const base = fixture()
    base.storage.set(LANGUAGE_KEY, 'false')
    base.storage.set(THEME_KEY, '#admin-token')
    const invalid = createUiPreferences(/* 此处没有系统或手选事件。 */ () => {}, base.host)
    assert.equal(invalid.state().languageChoice, 'system')
    assert.equal(invalid.state().themeChoice, 'system')
    invalid.dispose()
    const host: PreferenceHost = {
      ...base.host,
      read: /* 模拟浏览器阻止localStorage访问。 */ () => {
        throw new Error('storage blocked')
      },
      write: /* 模拟配额或隐私拒绝保存。 */ () => {
        throw new Error('storage unavailable')
      }
    }
    const current = createUiPreferences(/* 存储异常不影响当前页呈现。 */ () => {}, host)
    current.setLanguage('en')
    current.setTheme('dark')
    assert.equal(current.state().language, 'en')
    assert.equal(current.state().theme, 'dark')
    const reloaded = createUiPreferences(/* 未保存的偏好在重新加载时回到系统默认。 */ () => {}, host)
    assert.equal(reloaded.state().language, 'zh-CN')
    assert.equal(reloaded.state().theme, 'light')
    current.dispose()
    reloaded.dispose()
    base.preferences.dispose()
  }
)
