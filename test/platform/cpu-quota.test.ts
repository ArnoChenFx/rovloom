/** 使用明确的 cgroup 文本 fixture，验证当前层级和祖先配额，不依赖 CI 机器配置。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCpuQuota, probeCpuQuota } from '../../src/platform/cpu-quota.js'
import { readPrivateBytes } from '../../src/storage/files.js'

function probe(files: Record<string, string>): number | null {
  return probeCpuQuota('linux', (path) => files[path]).cpu_quota
}

test('CPU 配额保留小数核，未限额与非法数据不混淆', () => {
  assert.equal(parseCpuQuota('50000', '100000'), 0.5)
  assert.equal(parseCpuQuota('25000', '100000'), 0.25)
  assert.equal(parseCpuQuota('max', '100000'), null)
  assert.equal(parseCpuQuota('-1', '100000'), null)
  for (const [quota, period] of [
    ['0', '100000'],
    ['1', '0'],
    ['NaN', '1'],
    ['1', '-1'],
    ['1.5', '100']
  ]) {
    assert.throws(() => parseCpuQuota(quota!, period!))
  }
})

test('cgroup v2 按进程路径寻找挂载并取祖先最紧限制，不能只读根 cpu.max', () => {
  const files = {
    '/proc/self/cgroup': '0::/group/leaf\n',
    '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    '/sys/fs/cgroup/cpu.max': 'max 100000\n',
    '/sys/fs/cgroup/group/cpu.max': '25000 100000\n',
    '/sys/fs/cgroup/group/leaf/cpu.max': '50000 100000\n'
  }
  assert.equal(probe(files), 0.25)
  assert.equal(probe({ ...files, '/sys/fs/cgroup/group/cpu.max': 'max 100000\n' }), 0.5)
  assert.equal(probe({ ...files, '/sys/fs/cgroup/group/leaf/cpu.max': 'invalid' }), null)
})

test('cgroup v1 支持 cpu,cpuacct 与子树挂载，忽略其它控制器的目录', () => {
  assert.equal(
    probe({
      '/proc/self/cgroup': '5:memory:/memory\n4:cpu,cpuacct:/tenant/job\n',
      '/proc/self/mountinfo': '28 23 0:25 /tenant /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
      '/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us': '50000\n',
      '/sys/fs/cgroup/cpu/job/cpu.cfs_period_us': '100000\n'
    }),
    0.5
  )
})

test('非本机层级、路径越界、读取失败或非 Linux 时不编造配额', () => {
  const base = {
    '/proc/self/cgroup': '0::/other\n',
    '/proc/self/mountinfo': '29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    '/sys/fs/cgroup/cpu.max': '50000 100000\n'
  }
  assert.equal(probe(base), null)
  assert.equal(probe({ ...base, '/proc/self/cgroup': '0::/tenant/../other\n' }), null)
  const unknown = { cpu_quota: null, cpu_quota_status: 'unknown' }
  assert.deepEqual(
    probeCpuQuota('linux', () => {
      throw new Error('synthetic_read_failure')
    }),
    unknown
  )
  assert.deepEqual(
    probeCpuQuota('darwin', () => {
      throw new Error('must_not_read')
    }),
    unknown
  )
  assert.deepEqual(
    probeCpuQuota('win32', () => {
      throw new Error('must_not_read')
    }),
    unknown
  )
})

test('完整未限额、没有控制器资料与有限配额具有不同状态', () => {
  const files: Record<string, string> = {
    '/proc/self/cgroup': '0::/\n',
    '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    '/sys/fs/cgroup/cpu.max': 'max 100000\n'
  }
  const sample = () => probeCpuQuota('linux', (path) => files[path])
  assert.deepEqual(sample(), { cpu_quota: null, cpu_quota_status: 'unlimited' })
  files['/sys/fs/cgroup/cpu.max'] = '50000 100000\n'
  assert.deepEqual(sample(), { cpu_quota: 0.5, cpu_quota_status: 'limited' })
  delete files['/sys/fs/cgroup/cpu.max']
  assert.deepEqual(sample(), { cpu_quota: null, cpu_quota_status: 'unknown' })
})

test('深度截断或祖先不可读时保留已读配额上界并标为 partial', () => {
  const current = '/group/' + Array(130).fill('child').join('/')
  const sample = (fail: boolean) =>
    probeCpuQuota('linux', (path) => {
      if (path === '/proc/self/cgroup') {
        return '0::' + current + '\n'
      }
      if (path === '/proc/self/mountinfo') {
        return '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n'
      }
      if (path === '/sys/fs/cgroup' + current + '/cpu.max') {
        return '50000 100000\n'
      }
      if (fail) {
        throw new Error('synthetic_ancestor_unreadable')
      }
      return 'max 100000\n'
    })
  assert.deepEqual(sample(false), { cpu_quota: 0.5, cpu_quota_status: 'partial' })
  assert.deepEqual(sample(true), { cpu_quota: 0.5, cpu_quota_status: 'partial' })
})

test('v2 多挂载只匹配成员所在 root，正确解码挂载点中的八进制空格', () => {
  const files: Record<string, string> = {
    '/proc/self/cgroup': '0::/tenant/job\n',
    '/proc/self/mountinfo': [
      '28 23 0:25 /other /unrelated rw - cgroup2 cgroup rw',
      '29 23 0:26 /tenant /sys/fs/cgroup/space\\040view rw - cgroup2 cgroup rw'
    ].join('\n'),
    '/sys/fs/cgroup/space view/cpu.max': 'max 100000\n',
    '/sys/fs/cgroup/space view/job/cpu.max': '50000 100000\n'
  }
  const sampled = probeCpuQuota('linux', (path) => {
    assert(!path.startsWith('/unrelated'))
    return files[path]
  })
  assert.deepEqual(sampled, { cpu_quota: 0.5, cpu_quota_status: 'limited' })
})

test('Linux 默认读取器实际经过 procfs，结果状态与数值一致', { skip: process.platform !== 'linux' }, () => {
  // procfs 的 size=0 不能当成空内容；使用生产读取器核对这一边界。
  assert(readPrivateBytes('/proc/self/cgroup', 65_536).length > 0)
  assert(readPrivateBytes('/proc/self/mountinfo', 1_048_576).length > 0)
  const measured = probeCpuQuota()
  if (measured.cpu_quota_status === 'limited' || measured.cpu_quota_status === 'partial') {
    assert(typeof measured.cpu_quota === 'number' && Number.isFinite(measured.cpu_quota) && measured.cpu_quota > 0)
  } else {
    assert.equal(measured.cpu_quota, null)
  }
})
