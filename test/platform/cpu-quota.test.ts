/** 使用明确的 cgroup 文本 fixture，验证当前层级和祖先配额，不依赖 CI 机器配置。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCpuQuota, probeCpuQuota } from '../../src/platform/cpu-quota.js'

function probe(files: Record<string, string>): number | null {
  return probeCpuQuota('linux', (path) => files[path])
}

test('CPU 配额保留小数核，未限额与非法数据不混淆', () => {
  assert.equal(parseCpuQuota('50000', '100000'), 0.5)
  assert.equal(parseCpuQuota('25000', '100000'), 0.25)
  assert.equal(parseCpuQuota('max', '100000'), null)
  assert.equal(parseCpuQuota('-1', '100000'), null)
  for (const [quota, period] of [['0', '100000'], ['1', '0'], ['NaN', '1'], ['1', '-1'], ['1.5', '100']]) {
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
  assert.equal(probe({
    '/proc/self/cgroup': '5:memory:/memory\n4:cpu,cpuacct:/tenant/job\n',
    '/proc/self/mountinfo': '28 23 0:25 /tenant /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct\n',
    '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n',
    '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
    '/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us': '50000\n',
    '/sys/fs/cgroup/cpu/job/cpu.cfs_period_us': '100000\n'
  }), 0.5)
})

test('非本机层级、路径越界、读取失败或非 Linux 时不编造配额', () => {
  const base = {
    '/proc/self/cgroup': '0::/other\n',
    '/proc/self/mountinfo': '29 23 0:26 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    '/sys/fs/cgroup/cpu.max': '50000 100000\n'
  }
  assert.equal(probe(base), null)
  assert.equal(probe({ ...base, '/proc/self/cgroup': '0::/tenant/../other\n' }), null)
  assert.equal(probeCpuQuota('linux', () => { throw new Error('synthetic_read_failure') }), null)
  assert.equal(probeCpuQuota('darwin', () => { throw new Error('must_not_read') }), null)
  assert.equal(probeCpuQuota('win32', () => { throw new Error('must_not_read') }), null)
})
