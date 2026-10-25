// 使用临时配置、内存流和真实 Bun bundle 验证 CLI 拒绝、脱敏与关闭行为，不启动生产后端。
import { CliCancelled, configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import {
  configTemplate,
  parseConfig,
  readConfig,
  runCli,
  type CliRuntime,
  type GatewayConfig
} from '../../src/cli/index.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const marker = 'SYNTHETIC_SECRET_DO_NOT_PRINT'

// 为单个测试分配私有临时目录，并在成功或失败后统一删除。
function temporary(check: (directory: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-cli-test-'))
  return Promise.resolve()
    .then(/* 在目录已建立后运行本例检查，接住同步和异步失败。 */ () => check(directory))
    .finally(
      /* 清理本例拥有的目录，不保留配置或构建临时文件。 */ () => rmSync(directory, { recursive: true, force: true })
    )
}

// 在私有目录写入无密钥角色配置，供只读解析和启动拒绝测试使用。
function configFile(directory: string, role: 'gateway' | 'connector' = 'gateway') {
  const path = join(directory, `${role}.json`)
  const config = { ...configTemplate(role), state_dir: join(directory, 'state'), gateway_url: 'ws://localhost:9443' }
  writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
  return path
}

// 用内存流捕获命令输出和退出码，EOF 用于触发本地关闭路径。
async function capture(args: string[], runtime?: CliRuntime, stop = new AbortController()) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on(
    'data',
    /* 收集标准输出，供断言协议通道没有混入诊断。 */ (chunk) => {
      out += chunk
    }
  )
  stderr.on(
    'data',
    /* 收集标准错误，供核对稳定代码且无输入值反射。 */ (chunk) => {
      err += chunk
    }
  )
  const running = runCli(args, { stdin, stdout, stderr, signal: stop.signal }, runtime)
  stdin.end()
  return { code: await running, stdout: out, stderr: err }
}

test(
  '严格配置拒绝 secret、URL 身份、隐式相对路径和角色字段混用，模板无密钥',
  /* 组合秘密字段、路径和 URL 负例，检查模板与严格解析边界。 */ () => {
    for (const role of ['gateway', 'connector'] as const) {
      const template = configTemplate(role)
      assert.equal(parseConfig(configDocument(template)).role, role)
      assert(Object.isFrozen(template))
      for (const extra of [{ secret: marker }, { token: marker }, { principal_id: 'admin' }, { binary: '/bin/sh' }]) {
        assert.throws(
          /* 提交未声明字段，确认配置不能接纳额外身份或秘密。 */ () =>
            parseConfig({ ...configDocument(template), ...extra })
        )
      }
      for (const state_dir of ['relative', '~/state', '/tmp/../state', '/tmp//state', '/']) {
        assert.throws(
          /* 提交非规范状态路径，确认解析不依赖隐式展开。 */ () =>
            parseConfig({ ...configDocument(template), data: { directory: state_dir } })
        )
      }
    }
    const connector = configTemplate('connector')
    const gateway = configDocument(configTemplate('gateway'))
    for (const invalid of [
      { ...gateway, mcp: { hostname: 'localhost', port: 9444 } },
      { ...gateway, devices: { hostname: 'localhost', port: 9443 } },
      { ...gateway, devices: { hostname: '127.0.0.1', port: 9444 } },
      { ...gateway, management: { enabled: true, port: 9443 } },
      { ...gateway, management: { enabled: 'true', port: 9445 } },
      { ...gateway, devices: { hostname: '127.0.0.1', port: 0 } },
      { ...gateway, devices: { hostname: '127.0.0.1', port: 65536 } },
      { ...gateway, devices: { hostname: '127.0.0.1', port: 9443, tls_ref: 'obsolete' } }
    ]) {
      assert.throws(/* 分组字段、端口与旧TLS选择不能越过正式配置边界。 */ () => parseConfig(invalid))
    }
    const disabled = { ...gateway, management: { enabled: false, hostname: '127.0.0.1', port: 9555 } }
    assert.deepEqual(configDocument(parseConfig(disabled)), disabled)
    // 通配绑定是显式可选的隔离环境配置，解析与序列化往返保持原值；管理面只多接受 0.0.0.0。
    const wildcard = {
      ...gateway,
      mcp: { hostname: '0.0.0.0', port: 9444 },
      management: { enabled: true, hostname: '0.0.0.0', port: 9445 }
    }
    assert.deepEqual(configDocument(parseConfig(wildcard)), wildcard)
    assert.throws(
      /* 管理面不接受 IPv6 或具名地址。 */ () =>
        parseConfig({ ...gateway, management: { enabled: true, hostname: '::1', port: 9445 } })
    )
    assert.throws(/* 旧扁平用户格式不再接受，也不提供隐式迁移。 */ () => parseConfig(configTemplate('gateway')))
    for (const gateway_url of [
      `wss://user:${marker}@localhost:9443`,
      `wss://localhost:9443/?token=${marker}`,
      `wss://localhost:9443/#${marker}`,
      `wss://localhost:9443/${marker}`,
      'https://localhost:9443',
      'wss://localhost:9443?'
    ]) {
      assert.throws(
        /* 提交携带凭据或额外路径的 URL，确认其被拒绝。 */ () =>
          parseConfig({ ...configDocument(connector), gateway: { url: gateway_url } })
      )
    }
    assert.throws(
      /* 提交重复 provider 引用，确认配置不会产生歧义绑定。 */ () =>
        parseConfig({ ...configDocument(connector), provider_config_refs: ['same', 'same'] })
    )
    assert.throws(
      /* 将本地路径伪装成引用，确认不会变成模块加载入口。 */ () =>
        parseConfig({ ...configDocument(connector), provider_config_refs: ['/private/provider'] })
    )
  }
)

test(
  '只读配置沿用普通文件权限和链接，仍拒绝无界内容及非法编码',
  { timeout: 30_000 },
  /* 在隔离文件系统中验证普通读取、编码与大小限制。 */ async () => {
    await temporary(
      /* 依次改变自有配置权限和内容，确认读取不改写文件权限。 */ (directory) => {
        const path = configFile(directory)
        assert.equal(readConfig(path).role, 'gateway')
        chmodSync(path, 0o644)
        assert.equal(readConfig(path).role, 'gateway')
        assert.equal(statSync(path).mode & 0o777, 0o644)
        const link = join(directory, 'link.json')
        symlinkSync(path, link)
        assert.deepEqual(readConfig(link), readConfig(path))
        chmodSync(directory, 0o755)
        assert.equal(readConfig(path).role, 'gateway')
        assert.equal(statSync(directory).mode & 0o777, 0o755)
        writeFileSync(path, 'x'.repeat(16_385))
        assert.throws(/* 读取超大文件，确认不会无界收集配置内容。 */ () => readConfig(path))
        writeFileSync(path, Buffer.from([0xff]))
        assert.throws(/* 读取非法 UTF-8 配置，确认不会替换字符后继续使用。 */ () => readConfig(path))
      }
    )
  }
)

test(
  'help、配置检查和缺后端退出码明确；所有非法命令及异常均不回显秘密',
  { timeout: 30_000 },
  /* 覆盖命令解析、缺后端退出码和错误脱敏，避免假成功。 */ async () => {
    await temporary(
      /* 使用同一隔离配置逐项检查帮助、角色拒绝和模板输出。 */ async (directory) => {
        const path = configFile(directory)
        for (const args of [[], ['--help'], ['gateway', '--help'], ['connector', '--help'], ['--version']]) {
          const result = await capture(args)
          assert.equal(result.code, 0)
          assert.equal(result.stdout, '')
          assert(result.stderr.includes('Rovloom'))
        }
        assert.deepEqual(await capture(['config', 'check', '--config', path]), {
          code: 0,
          stdout: '',
          stderr: 'config_valid\n'
        })
        assert.deepEqual(await capture(['gateway', '--config', path]), {
          code: 3,
          stdout: '',
          stderr: 'backend_unavailable\n'
        })
        const connector = configFile(directory, 'connector')
        assert.deepEqual(await capture(['connector', '--config', connector]), {
          code: 3,
          stdout: '',
          stderr: 'backend_unavailable\n'
        })
        assert.equal((await capture(['connector', '--config', path])).code, 2)
        for (const args of [
          ['pair', marker],
          ['gateway', '--token', marker],
          ['connector', '--enrollment', marker],
          ['gateway', '--config', path, '--help'],
          ['gateway', '--config', `${path}/${marker}`]
        ]) {
          const result = await capture(args)
          assert.equal(result.code, 2)
          assert.equal(result.stdout, '')
          assert(!result.stderr.includes(marker))
          assert(!result.stderr.includes(directory))
        }
        const failure = await capture(['gateway', '--config', path], {
          gateway: /* 让宿主抛出含合成秘密的异常，检验 CLI 只输出固定错误码。 */ async () => {
            throw new Error(`${marker} /private/backend`)
          }
        })
        assert.deepEqual(failure, { code: 1, stdout: '', stderr: 'runtime_failed\n' })
        const template = await capture(['config', 'template', 'gateway'])
        assert.equal(template.code, 0)
        assert.deepEqual(JSON.parse(template.stdout), configDocument(configTemplate('gateway')))
        assert.equal(template.stderr, '')
      }
    )
  }
)

test(
  '注入角色仅使用固定配置；EOF不停止Gateway，终止信号关闭资源，失败关闭不报告成功',
  { timeout: 30_000 },
  /* 验证注入角色的持久HTTP、终止信号和失败关闭语义，不启动真实服务。 */ async () => {
    await temporary(
      /* 在临时配置下记录两角色清理次数，检查关闭幂等和错误传播。 */ async (directory) => {
        const path = configFile(directory)
        let closed = 0
        const gatewayStop = new AbortController()
        const result = await capture(
          ['gateway', '--config', path],
          {
            gateway: /* 检查 Gateway 收到固定配置，并提供仅供生命周期测试的宿主。 */ async (config: GatewayConfig) => {
              assert.equal(config.authentication_ref, 'mcp-callers')
              return {
                // 仅测试生命周期的 stub，不提供任何成功的业务动作。
                service: {
                  execute: /* 禁止本例执行任何业务动作，避免关闭测试伪装后端成功。 */ async () => {
                    throw new Error('unused_stub')
                  }
                },
                authentication: { authenticate: /* 拒绝全部HTTP身份，生命周期测试无法获得业务权限。 */ () => null },
                listening: /* stdin已EOF仍必须持续监听，只有显式宿主终止才结束角色。 */ () => {
                  assert.equal(closed, 0)
                  gatewayStop.abort()
                },
                close: /* 记录 Gateway 资源释放次数，核对 EOF 清理只发生一次。 */ async () => {
                  closed++
                }
              }
            }
          },
          gatewayStop
        )
        assert.deepEqual(result, { code: 0, stdout: '', stderr: '' })
        assert.equal(closed, 1)
        const stop = new AbortController()
        const connector = configFile(directory, 'connector')
        let connectorClosed = 0
        const stopped = await capture(
          ['connector', '--config', connector],
          {
            connector: /* 在 Connector 启动后立即触发终止信号，验证宿主仍会关闭。 */ async () => {
              stop.abort()
              return {
                closed: new Promise<void>(/* 保持运行完成信号待定，使本例只能由终止信号结束等待。 */ () => {}),
                close: /* 记录 Connector 关闭次数，核对取消等待没有漏掉资源释放。 */ async () => {
                  connectorClosed++
                }
              }
            }
          },
          stop
        )
        assert.equal(stopped.code, 0)
        assert.equal(connectorClosed, 1)
        const failure = await capture(['connector', '--config', connector], {
          connector: /* 提供已结束的 Connector，再让关闭失败，以检查失败退出码。 */ async () => ({
            closed: Promise.resolve(),
            close: /* 抛出合成秘密异常，确认关闭失败不会泄露原始消息。 */ async () => {
              throw new Error(marker)
            }
          })
        })
        assert.deepEqual(failure, { code: 1, stdout: '', stderr: 'runtime_failed\n' })
      }
    )
  }
)

test(
  '问答取消沿原Gateway关闭路径正常退出，取消后的真正关闭失败仍报告运行失败',
  /* 两种结果共享明确的本机取消，仅关闭故障不同；不能把signal.aborted当作所有异常的成功开关。 */ async () => {
    await temporary(
      /* 实际HTTP生命周期由runCli打开并关闭，宿主只提供无业务权限的清理结果。 */ async (directory) => {
        for (const failed of [false, true]) {
          const stop = new AbortController()
          let closed = 0
          const result = await capture(
            ['gateway', '--config', configFile(directory)],
            {
              gateway: /* 仅验证取消和清理，不提供原生或身份成功替身。 */ async () => ({
                service: {
                  execute: /* 禁止生命周期测试派发业务。 */ async () => {
                    throw new Error('unused_stub')
                  }
                },
                authentication: { authenticate: /* 拒绝所有HTTP身份。 */ () => null },
                listening: /* 与真实问答相同，先确认进程signal已取消再抛专用取消标记。 */ () => {
                  stop.abort()
                  throw new CliCancelled()
                },
                close: /* 失败分支保留真实关闭错误，不能被先前取消标记压掉。 */ async () => {
                  closed++
                  if (failed) {
                    throw new Error(marker)
                  }
                }
              })
            },
            stop
          )
          assert.equal(closed, 1)
          assert.deepEqual(result, {
            code: failed ? 1 : 0,
            stdout: '',
            stderr: failed ? 'runtime_failed\n' : ''
          })
        }
      }
    )
  }
)

test(
  '同一 Bun bundle 提供两个角色及 help/config；独立产物缺后端不会伪装成功',
  { timeout: 30_000 },
  /* 构建一个独立 bundle，证明两个角色共用入口且缺后端时拒绝。 */ async () => {
    await temporary(
      /* 在临时目录构建并启动产物，不依赖源码路径下的运行入口。 */ (directory) => {
        const artifact = join(directory, 'rovloom.js')
        const build = spawnSync(
          process.execPath,
          ['--no-env-file', 'build', 'src/cli/main.ts', '--target=bun', '--outfile', artifact],
          {
            cwd: repo,
            encoding: 'utf8',
            timeout: 30_000,
            env: { PATH: process.env.PATH ?? '' }
          }
        )
        assert.equal(build.status, 0, build.stdout + build.stderr)
        const run = /* 以最小环境运行同一 bundle，收集真实子进程退出码与输出。 */ (args: string[]) =>
          spawnSync(process.execPath, ['--no-env-file', artifact, ...args], {
            cwd: directory,
            encoding: 'utf8',
            timeout: 5000,
            env: { PATH: process.env.PATH ?? '' }
          })
        assert.match(run(['--help']).stderr, /Rovloom/)
        // 默认英文，仅 ROVLOOM_LANG 切换中文；系统 locale 不影响语言，同一 bundle 的语言选择互不影响。
        const cjk = /[\u{4e00}-\u{9fff}]/u
        assert.doesNotMatch(run(['--help']).stderr, cjk)
        const zhHelp = spawnSync(process.execPath, ['--no-env-file', artifact, '--help'], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 5000,
          env: { PATH: process.env.PATH ?? '', ROVLOOM_LANG: 'zh-CN' }
        })
        assert.equal(zhHelp.status, 0)
        assert.match(zhHelp.stderr, /用法：/)
        const localeHelp = spawnSync(process.execPath, ['--no-env-file', artifact, '--help'], {
          cwd: directory,
          encoding: 'utf8',
          timeout: 5000,
          env: { PATH: process.env.PATH ?? '', LANG: 'zh_CN.UTF-8' }
        })
        assert.equal(localeHelp.status, 0)
        assert.match(localeHelp.stderr, /Usage:/)
        assert.doesNotMatch(localeHelp.stderr, cjk)
        const serviceHelp = run(['service', '--help'])
        assert.equal(serviceHelp.status, 0)
        assert.equal(serviceHelp.stdout, '')
        assert.match(serviceHelp.stderr, /uninstall never stops it/)
        const service = run(['service', 'uninstall', '--role', 'connector'])
        assert.equal(service.status, 3)
        assert.equal(service.stdout, '')
        assert.equal(service.stderr, 'backend_unavailable\n')
        const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
        assert.equal(run(['--version']).stderr, `Rovloom ${manifest.version}\n`)
        for (const role of ['gateway', 'connector'] as const) {
          const template = run(['config', 'template', role])
          assert.equal(template.status, 0)
          assert.deepEqual(JSON.parse(template.stdout), configDocument(configTemplate(role)))
          const result = run([role, '--config', configFile(directory, role)])
          assert.equal(result.status, role === 'connector' ? 2 : 3)
          assert.equal(result.stdout, '')
          assert.match(result.stderr, role === 'connector' ? /^configuration_required\n/ : /^backend_unavailable\n$/)
        }
      }
    )
  }
)
