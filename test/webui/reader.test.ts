/** 以隔离时钟和只读 fixture 验证页面生命周期，不模拟真实管理员授权或 Connector。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSnapshotReader, ReadError, type ReadClock, type TimedSnapshot } from '../../src/webui/reader.js'

/** 提供可精确推进的单调时钟，并暴露资源计数以验证页面释放。 */
function fakeClock() {
  let time = 0
  let serial = 0
  const tasks = new Map<number, { due: number; callback: () => void }>()
  const clock: ReadClock = {
    /** 返回受测试控制的单调时间。 */
    now: () => time,
    /** 登记一个可取消任务。 */
    schedule: (callback, delay) => {
      const id = ++serial
      tasks.set(id, { due: time + delay, callback })
      return id
    },
    /** 删除指定任务。 */
    clear: (id) => {
      tasks.delete(id as number)
    }
  }
  return {
    clock,
    /** 按期限依次执行到指定时点的所有任务。 */
    advance: (amount: number) => {
      const end = time + amount
      while (true) {
        let next: [number, { due: number; callback: () => void }] | undefined
        for (const entry of tasks) {
          if (entry[1].due <= end && (!next || entry[1].due < next[1].due)) {
            next = entry
          }
        }
        if (!next) {
          break
        }
        time = next[1].due
        tasks.delete(next[0])
        next[1].callback()
      }
      time = end
    },
    /** 查看尚未释放的任务数量。 */
    count: () => tasks.size
  }
}

/** 创建主动解析的延迟 fixture，验证不遵守 AbortSignal 的迟到响应也不能污染页面。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>(
    /** 向测试暴露响应控制，而不运行任何生产数据源。 */
    (done, fail) => {
      resolve = done
      reject = fail
    }
  )
  return { promise, resolve, reject }
}

/** 只构造页面内部时间投影，内容不从生产入口导入。 */
function sample(value = 'machine-a', expires: number | null = null): TimedSnapshot<string> {
  return { value, serverTime: 100_000, observedAt: 100_000, sessionExpiresAt: expires }
}

/** 消化读取适配层 Promise 链，保持定时器完全受测试控制。 */
async function flush(): Promise<void> {
  for (let count = 0; count < 8; count++) {
    await Promise.resolve()
  }
}

// 同一请求内的反复刷新必须共享 Promise，不因重复点击增加读取。
test(
  '重复刷新只读取一次，取消后拒绝迟到响应',
  /* 同一请求内的反复刷新必须共享 Promise，不因重复点击增加读取。 */ async () => {
    const timer = fakeClock()
    const pending = deferred<TimedSnapshot<string>>()
    let reads = 0
    let signal: AbortSignal | undefined
    const reader = createSnapshotReader(
      /** 记录测试读取及取消信号。 */
      (current) => {
        reads++
        signal = current
        return pending.promise
      },
      /** 本测试直接检查状态，不挂载页面。 */
      () => {},
      timer.clock
    )
    const first = reader.refresh()
    assert.equal(reader.refresh(), first)
    await flush()
    assert.equal(reads, 1)
    reader.cancel()
    await first
    assert.equal(signal?.aborted, true)
    pending.resolve(sample())
    await flush()
    assert.equal(reader.state().snapshot, null)
    assert.equal(reader.state().problem, 'cancelled')
    reader.dispose()
    assert.equal(timer.count(), 0)
  }
)

// 超时后的新请求可以成功，旧请求随后到达也不能覆盖另一台机器。
test(
  '五秒超时释放请求，并隔离新旧响应',
  /* 超时后的新请求可以成功，旧请求随后到达也不能覆盖另一台机器。 */ async () => {
    const timer = fakeClock()
    const old = deferred<TimedSnapshot<string>>()
    let reads = 0
    const reader = createSnapshotReader(
      /** 第一次请求悬挂，第二次返回另一机器。 */
      () => (++reads === 1 ? old.promise : Promise.resolve(sample('machine-b'))),
      /** 直接观察状态。 */
      () => {},
      timer.clock
    )
    const first = reader.refresh()
    await flush()
    timer.advance(5_000)
    await first
    assert.equal(reader.state().problem, 'timeout')
    assert.equal(reader.state().pending, false)
    await reader.refresh()
    assert.equal(reader.state().snapshot?.value, 'machine-b')
    old.resolve(sample('machine-a'))
    await flush()
    assert.equal(reader.state().snapshot?.value, 'machine-b')
    reader.dispose()
  }
)

// 读取失败时保留明确过期的只读数据，成功刷新才能恢复新鲜度。
test(
  '网络错误保留过期快照，固定分类不暴露原始异常',
  /* 读取失败时保留明确过期的只读数据，成功刷新才能恢复新鲜度。 */ async () => {
    const timer = fakeClock()
    let fail = false
    const reader = createSnapshotReader(
      /** 注入带假秘密的异常，页面状态只能得到固定分类。 */
      async () => {
        if (fail) {
          throw new Error('fixture-secret-should-never-render')
        }
        return sample()
      },
      /** 直接观察状态。 */
      () => {},
      timer.clock
    )
    await reader.refresh()
    assert.equal(reader.state().stale, false)
    fail = true
    await reader.refresh()
    assert.equal(reader.state().snapshot?.value, 'machine-a')
    assert.equal(reader.state().stale, true)
    assert.equal(reader.state().problem, 'unavailable')
    assert(!JSON.stringify(reader.state()).includes('fixture-secret'))
    fail = false
    await reader.refresh()
    assert.equal(reader.state().stale, false)
    reader.dispose()
  }
)

// 授权失败立即擦除快照并停止轮询；用户主动刷新是明确的重新尝试信号，会再读一次以复用已恢复的 cookie 会话。
for (const problem of ['unauthenticated', 'forbidden', 'not_found'] as const) {
  test(
    `${problem} 清空内存并停止轮询，主动刷新可重新尝试`,
    /* 验证 `${problem} 清空内存并停止轮询，主动刷新可重新尝试` 的读取与展示边界。 */ async () => {
      const timer = fakeClock()
      let reads = 0
      const reader = createSnapshotReader(
        /** 先成功，再撤回当前查看权限。 */
        async () => {
          if (++reads > 1) {
            throw new ReadError(problem)
          }
          return sample()
        },
        /** 直接观察状态。 */
        () => {},
        timer.clock
      )
      await reader.refresh()
      await reader.refresh()
      assert.equal(reader.state().snapshot, null)
      assert.equal(reader.state().problem, problem)
      // 认证失败后轮询已停止，不会自行重试。
      timer.advance(60_000)
      assert.equal(timer.count(), 0)
      // 用户主动刷新会重新读取一次，不因一次认证失败永久锁死页面。
      await reader.refresh()
      assert.equal(reads, 3)
      reader.dispose()
    }
  )
}

// 写请求发现认证失败时必须清空数据，但保留 reader 以便用户手动刷新重试（dispose 会永久封闭）。
test(
  'reset 清空数据并停止轮询，但保留 reader 可手动刷新重试',
  /** 与 dispose 的区别：刷新和重新可见仍然能发起新的读取。 */ async () => {
    const timer = fakeClock()
    let reads = 0
    const reader = createSnapshotReader(
      /** 每次读取都返回同一隔离快照。 */
      async () => {
        reads++
        return sample()
      },
      /** 直接观察状态。 */
      () => {},
      timer.clock
    )
    await reader.refresh()
    assert.equal(reader.state().snapshot?.value, 'machine-a')
    reader.reset('unauthenticated')
    // 数据立即清空，旧授权内容不能继续显示。
    assert.equal(reader.state().snapshot, null)
    assert.equal(reader.state().problem, 'unauthenticated')
    // 认证类失败后自动轮询停止。
    timer.advance(60_000)
    assert.equal(timer.count(), 0)
    // 用户主动刷新仍能读到新数据。
    const before = reads
    await reader.refresh()
    assert.equal(reads, before + 1)
    assert.equal(reader.state().snapshot?.value, 'machine-a')
    assert.equal(reader.state().problem, null)
    reader.dispose()
  }
)

// 页面隐藏后重新可见也必须能从 reset 状态恢复，而 dispose 过的 reader 不会。
test(
  'reset 后重新可见可恢复读取，dispose 后则永久停止',
  /** 覆盖「用户切回标签页自愈」这条路径。 */ async () => {
    const timer = fakeClock()
    let reads = 0
    const reader = createSnapshotReader(
      /** 统计读取次数。 */
      async () => {
        reads++
        return sample()
      },
      /** 直接观察状态。 */
      () => {},
      timer.clock
    )
    await reader.refresh()
    reader.visible(false)
    reader.reset('forbidden')
    reader.visible(true)
    await flush()
    assert.equal(reads, 2)
    assert.equal(reader.state().snapshot?.value, 'machine-a')
    // 对照：dispose 之后同样的可见性变化不会再读。
    reader.dispose()
    reader.visible(false)
    reader.visible(true)
    await flush()
    assert.equal(reads, 2)
  }
)

// 页面隐藏不消耗轮询，恢复可见后立即检查期限并重新取数据。
test(
  '隐藏暂停，前台立即刷新，卸载释放所有资源',
  /* 页面隐藏不消耗轮询，恢复可见后立即检查期限并重新取数据。 */ async () => {
    const timer = fakeClock()
    let reads = 0
    let notifications = 0
    const reader = createSnapshotReader(
      /** 统计固定 fixture 的读取次数。 */
      async () => {
        reads++
        return sample()
      },
      /** 记录卸载后的意外通知。 */
      () => {
        notifications++
      },
      timer.clock
    )
    await reader.refresh()
    reader.visible(false)
    assert.equal(timer.count(), 0)
    timer.advance(60_000)
    assert.equal(reads, 1)
    assert.equal(reader.state().stale, true)
    reader.visible(true)
    await flush()
    assert.equal(reads, 2)
    reader.dispose()
    const before = notifications
    timer.advance(60_000)
    await flush()
    assert.equal(timer.count(), 0)
    assert.equal(notifications, before)
  }
)

// 后端 session 期限采用服务时间与单调经过时间，包含整个读取耗时。
test(
  '会话到期清空快照，隐藏期间到期也不得恢复读取',
  /* 后端 session 期限采用服务时间与单调经过时间，包含整个读取耗时。 */ async () => {
    const timer = fakeClock()
    let reads = 0
    const reader = createSnapshotReader(
      /** 返回十秒后到期的隔离会话时间投影。 */
      async () => {
        reads++
        return sample('machine-a', 110_000)
      },
      /** 直接观察状态。 */
      () => {},
      timer.clock
    )
    await reader.refresh()
    reader.visible(false)
    timer.advance(10_000)
    reader.visible(true)
    await flush()
    assert.equal(reader.state().problem, 'unauthenticated')
    assert.equal(reader.state().snapshot, null)
    assert.equal(reads, 1)
    assert.equal(timer.count(), 0)
    reader.dispose()
  }
)

// 新请求进行中也必须显示前一次观测的真实年龄，十五秒为过期阈值。
test(
  '年龄使用服务时间和单调经过时间，十五秒标记过期',
  /* 新请求进行中也必须显示前一次观测的真实年龄，十五秒为过期阈值。 */ async () => {
    const timer = fakeClock()
    const reader = createSnapshotReader(
      /** 初次观测本身已延迟十秒。 */
      async () => ({ ...sample(), observedAt: 90_000 }),
      /** 直接观察状态。 */
      () => {},
      timer.clock
    )
    await reader.refresh()
    assert.equal(reader.state().ageMs, 10_000)
    assert.equal(reader.state().stale, false)
    timer.advance(4_999)
    assert.equal(reader.state().stale, false)
    timer.advance(1)
    assert.equal(reader.state().stale, true)
    reader.dispose()
  }
)

// 未来观测、非有限时间及过期会话均不能作为成功的新鲜快照。
test(
  '非法时间投影与已过期会话均失败关闭',
  /* 未来观测、非有限时间及过期会话均不能作为成功的新鲜快照。 */ async () => {
    for (const result of [
      { ...sample(), observedAt: 100_001 },
      { ...sample(), serverTime: Number.NaN },
      { ...sample(), sessionExpiresAt: Infinity }
    ]) {
      const timer = fakeClock()
      const reader = createSnapshotReader(
        /** 返回一个非法时间投影。 */
        async () => result,
        /** 直接观察状态。 */
        () => {},
        timer.clock
      )
      await reader.refresh()
      assert.equal(reader.state().snapshot, null)
      assert.equal(reader.state().problem, 'invalid_response')
      reader.dispose()
    }
  }
)

// 导航必须销毁旧 reader，随后无论旧请求成功还是认证失败都不能更新页面。
test(
  '离开页面后迟到认证失败不通知新页面',
  /* 导航必须销毁旧 reader，随后无论旧请求成功还是认证失败都不能更新页面。 */ async () => {
    const timer = fakeClock()
    const pending = deferred<TimedSnapshot<string>>()
    let notifications = 0
    const reader = createSnapshotReader(
      /** 延迟旧路由的读取。 */
      () => pending.promise,
      /** 记录旧路由渲染通知。 */
      () => {
        notifications++
      },
      timer.clock
    )
    const request = reader.refresh()
    await flush()
    reader.dispose()
    await request
    const before = notifications
    pending.reject(new ReadError('unauthenticated'))
    await flush()
    assert.equal(notifications, before)
    assert.equal(reader.state().snapshot, null)
    assert.equal(timer.count(), 0)
  }
)
