/** 只验证 musl 容器启动方式的映射与原生路径不变；不启动真实容器或产品。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALPINE_IMAGE, ALPINE_PACKAGES, alpineRuntime } from '../../scripts/release/alpine.mjs'
import { nativeRuntime, smokeRuntime } from '../../scripts/release/runtime.mjs'
import { runtimeLibc } from '../../scripts/release/libc.mjs'
import { assertPlatformMatrix, declaredPlatform, assertHostMatchesPlatform } from '../../scripts/release/metadata.mjs'

const cwd = '/tmp/rovloom-cwd'
const env = Object.freeze({ PATH: '', HOME: '/tmp/rovloom-home', LANG: 'C.UTF-8', NO_COLOR: '1' })
const exists = /** 只有本次明确声明的目录存在，不读取宿主文件系统。 */ (path) =>
  ['/tmp/rovloom-cwd', '/tmp/rovloom-home', '/tmp/rovloom-bin'].includes(path)

test(
  'musl product acceptance runs the real binary inside one Alpine container with libstdc++',
  /** 断言只有启动方式被替换：argv、环境与 cwd 语义保持不变。 */ () => {
    const runtime = alpineRuntime({ docker: 'docker', uid: 1000, gid: 1000, exists })
    assert.equal(runtime.image, ALPINE_IMAGE)
    assert.deepEqual([...runtime.packages], [...ALPINE_PACKAGES])
    assert.deepEqual([...ALPINE_PACKAGES], ['libstdc++', 'su-exec'])
    const launch = runtime.wrap('/tmp/rovloom-bin/rovloom', ['--version'], { cwd, env })
    assert.equal(launch.file, 'docker')
    assert.equal(launch.cwd, cwd)
    const args = launch.args
    assert.deepEqual(args.slice(0, 2), ['run', '--rm'])
    // 共享宿主网络命名空间，产品绑定的 127.0.0.1 端口才能被驱动进程访问。
    assert.deepEqual(args.slice(2, 4), ['--network', 'host'])
    assert.deepEqual(args.slice(4, 6), ['--workdir', cwd])
    // 容器以 root 启动（apk 数据库需要写权限），不再以 --user 降权。
    assert(!args.includes('--user'))
    // 结构固定为：... [shell, 标记, 环境对..., 可执行文件, ...argv]。
    assert.deepEqual(args.slice(-2), ['/tmp/rovloom-bin/rovloom', '--version'])
    const marker = args.indexOf('rovloom-alpine')
    assert.deepEqual(args.slice(marker + 1, -2), ['PATH=', 'HOME=/tmp/rovloom-home', 'LANG=C.UTF-8', 'NO_COLOR=1'])
    const shell = args[args.indexOf('-c') + 1]
    // 先装 libstdc++ 与 su-exec（musl 产物 NEEDED 依赖前者），再以 su-exec 降回宿主 uid/gid
    // 并用 env -i 清空容器环境执行真实命令。
    assert.match(shell, /^apk add --no-cache libstdc\+\+ su-exec >\/dev\/null && exec su-exec 1000:1000 env -i "\$@"/u)
    // 降权目标必须等于宿主 uid/gid，产物写出的文件才仍归当前用户。
    assert(shell.includes('su-exec 1000:1000'), 'the command must drop back to the host uid/gid')
    for (const pair of ['PATH=', 'HOME=/tmp/rovloom-home', 'LANG=C.UTF-8', 'NO_COLOR=1']) {
      assert(args.includes(pair), `missing environment ${pair}`)
    }
    // 只挂载声明的目录，绝不挂载宿主根。
    const mounted = args.filter(/** 只收集挂载源。 */ (_value, index) => args[index - 1] === '-v')
    assert.deepEqual(mounted, [
      '/tmp/rovloom-bin:/tmp/rovloom-bin',
      '/tmp/rovloom-cwd:/tmp/rovloom-cwd',
      '/tmp/rovloom-home:/tmp/rovloom-home'
    ])
    assert(!mounted.some(/** 根目录不能被整体暴露。 */ (value) => value.startsWith('/:/')))
    // 未带冒号的绝对路径只应是可执行文件与工作目录；HOME 只作为环境值出现。
    assert.deepEqual([...new Set(args.filter((value) => value.startsWith('/tmp/') && !value.includes(':')))].sort(), [
      '/tmp/rovloom-bin/rovloom',
      '/tmp/rovloom-cwd'
    ])
  }
)

test(
  'musl container wrapping rejects non-canonical image or package names and omits undefined env',
  /** 镜像和包来自固定常量，不接受任意 shell 片段。 */ () => {
    for (const options of [{ image: 'alpine:3.20; rm -rf /' }, { packages: ['libstdc++ && id'] }, { image: '' }]) {
      assert.throws(() => alpineRuntime(options), /invalid_alpine_runtime/u)
    }
    const runtime = alpineRuntime({ exists, uid: 0, gid: 0 })
    const launch = runtime.wrap('/tmp/rovloom-bin/rovloom', ['--help'], {
      cwd,
      env: { HOME: '/tmp/rovloom-home', PATH: undefined, EMPTY: '' }
    })
    const pairs = launch.args.slice(launch.args.indexOf('rovloom-alpine') + 1, -2)
    // undefined 不进入环境；空字符串必须保留（产品 smoke 显式使用空 PATH）。
    assert.deepEqual(pairs, ['HOME=/tmp/rovloom-home', 'EMPTY='])
  }
)

test(
  'native runtime leaves executable, argv and environment untouched',
  /** 非 musl 目标不得被悄悄包进容器。 */ () => {
    const launch = nativeRuntime.wrap('/tmp/rovloom-bin/rovloom', ['gateway', '--config', '/tmp/cfg'], { cwd, env })
    assert.equal(launch.file, '/tmp/rovloom-bin/rovloom')
    assert.deepEqual(launch.args, ['gateway', '--config', '/tmp/cfg'])
    assert.equal(launch.cwd, cwd)
    assert.deepEqual(launch.env, env)
    assert.equal(smokeRuntime({}), nativeRuntime)
    assert.equal(smokeRuntime({ ROVLOOM_MUSL_ALPINE: '0' }), nativeRuntime)
    assert.equal(smokeRuntime({ ROVLOOM_MUSL_ALPINE: '1' }).kind, 'alpine')
  }
)

test(
  'runtime libc comes from the Bun report or the musl loader, never from a default',
  /** glibc 由运行时报告证明，musl 由官方加载器文件证明，其余情况拒绝。 */ () => {
    assert.equal(runtimeLibc({ platform: 'darwin' }), null)
    assert.equal(runtimeLibc({ platform: 'linux', report: { glibcVersionRuntime: '2.36' } }), 'glibc')
    for (const arch of ['x64', 'arm64']) {
      const loader = arch === 'x64' ? '/lib/ld-musl-x86_64.so.1' : '/lib/ld-musl-aarch64.so.1'
      assert.equal(runtimeLibc({ platform: 'linux', arch, report: {}, exists: (path) => path === loader }), 'musl')
    }
    assert.throws(
      () => runtimeLibc({ platform: 'linux', report: {}, exists: () => false }),
      /unsupported_release_libc/u
    )
    assert.throws(
      () => runtimeLibc({ platform: 'linux', arch: 'armv7', report: {}, exists: () => true }),
      /unsupported_release_libc/u
    )
  }
)

test(
  'the declared target picks the platform, so a musl job can run on a glibc runner',
  /** 矩阵与契约逐项一致，且每个 target 都是对应平台的 Bun 编译目标。 */ () => {
    const matrix = assertPlatformMatrix()
    assert.equal(matrix.length, 8)
    assert.deepEqual(
      matrix.map((item) => item.target),
      [
        'bun-linux-x64',
        'bun-linux-x64-musl',
        'bun-linux-arm64',
        'bun-linux-arm64-musl',
        'bun-darwin-x64',
        'bun-darwin-arm64',
        'bun-windows-x64',
        'bun-windows-arm64'
      ]
    )
    assert.deepEqual(
      matrix.filter(/** 只有 Linux 携带 libc。 */ (item) => item.os === 'linux').map((item) => item.libc),
      ['glibc', 'musl', 'glibc', 'musl']
    )
    if (process.platform === 'linux' && process.arch === 'x64') {
      // 平台必须按 CI 声明的目标选，而不是按宿主 libc：musl job 就跑在 glibc runner 上。
      const musl = declaredPlatform('bun-linux-x64-musl')
      assert.equal(musl.libc, 'musl')
      assert.equal(musl.target, 'bun-linux-x64-musl')
      const glibc = declaredPlatform('bun-linux-x64')
      assert.equal(glibc.libc, 'glibc')
      // 同 OS 同架构的 runner 可以验收 musl 目标；libc 不参与 musl 的宿主断言。
      assert.equal(assertHostMatchesPlatform(musl), musl)
      assert.equal(assertHostMatchesPlatform(glibc), glibc)
    }
    // 未声明的目标、别名或交叉架构都必须被拒，不能悄悄回退到宿主平台。
    for (const target of [undefined, '', 'linux-x64-musl', 'bun-linux-x64-glibc']) {
      assert.throws(() => declaredPlatform(target), /Unsupported declared release target/u)
    }
  }
)
