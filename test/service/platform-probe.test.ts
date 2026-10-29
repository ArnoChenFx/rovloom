// 使用实际宿主的原生解析器只读核对声明；不注册任务、不加载系统单元、不提权或改变权限。
import { phaseTiming } from '../support/phase-timing.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { renderDefinition } from '../../src/service/render.js'
import {
  createSystemCommandRunner,
  SystemCommandError,
  type CommandPlan,
  type CommandResult
} from '../../src/service/runner.js'
import { sampleSpec } from './helpers.js'
import { taskCall } from '../../src/service/windows.js'

// 只观察本次桥已有的stderr和子进程阶段；不另起观察进程，不注册任务，也不重试失败操作。
async function bridgeProbe(plan: CommandPlan) {
  const stages = ['script_started', 'serializer_loaded', 'input_read', 'scheduler_connected', 'validated']
  const began = performance.now()
  const beganWall = Date.now()
  // 所有接收事件共用同一单调时钟，避免混用子进程创建和脚本执行时长。
  const elapsed = () => Math.round(performance.now() - began)
  const times: Record<string, number> = {}
  const diagnosticDirectory = mkdtempSync(join(tmpdir(), 'rovloom-powershell-timing-'))
  const firstStatement = join(diagnosticDirectory, 'first-statement.txt')
  let phase = 'not_started'
  let progress = ''
  let script = Buffer.from(plan.args.at(-1)!, 'base64').toString('utf16le')
  for (const [before, stage] of [
    ["$ErrorActionPreference = 'Stop'", 'script_started'],
    ['$json = ', 'serializer_loaded'],
    ['  if ($p.name', 'input_read'],
    ['[IO.File]::WriteAllText($p.PhasePath,', 'input_read'],
    ["[IO.File]::WriteAllText($p.PhasePath,'connected')", 'scheduler_connected'],
    ['  $folder = ', 'scheduler_connected']
  ]) {
    script = script.replace(before!, `[Console]::Error.WriteLine('rovloom_probe_${stage}')\n${before}`)
  }
  // 首句文件独立于stderr，防止把流尚未交付误判为PowerShell脚本尚未执行。
  script = `$rovloomProbeWork=[Diagnostics.Stopwatch]::StartNew()\n[IO.File]::WriteAllText($env:ROVLOOM_TEST_SERVICE_PHASE,[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString())\n${script}`
  const run = createSystemCommandRunner({
    start: /* 仅在测试中读取固定进度标记，不记录系统正文、路径或输入JSON。 */ ((
      file: string,
      args: readonly string[],
      options: SpawnOptions
    ) => {
      const child = spawn(file, args, {
        ...options,
        env: { ...options.env, ROVLOOM_TEST_SERVICE_PHASE: firstStatement }
      })
      child.once(
        'spawn',
        /* 记录操作系统接受启动的耗时，不当成脚本ready。 */ () => {
          times.spawn = elapsed()
        }
      )
      child.stdin?.once(
        'finish',
        /* 输入已交付仍不能证明PowerShell已读取。 */ () => {
          times.input_finished = elapsed()
        }
      )
      child.once(
        'exit',
        /* 与close分别记录，识别退出后流回收延迟。 */ () => {
          times.exit = elapsed()
        }
      )
      child.once(
        'close',
        /* 只观察本次直接子进程，不按PID查询或另起观察器。 */ () => {
          times.close = elapsed()
        }
      )
      child.stderr?.on(
        'data',
        /* 进度观察有界，失败时只保留固定阶段。 */ (bytes: Buffer) => {
          progress = (progress + bytes.toString('utf8')).slice(-512)
          for (const stage of stages) {
            if (progress.includes('rovloom_probe_' + stage)) {
              phase = stage
              times[stage] ??= elapsed()
            }
          }
        }
      )
      return child
    }) as typeof spawn
  })
  try {
    const result = await run({
      ...plan,
      args: [...plan.args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')],
      // 整个系统工具沿用生产35秒硬上限；子进程单调时钟另外约束初始化完成后的功能执行。
      timeout: 35000
    })
    if (result.code === 0) {
      const measured = /^rovloom_probe_work_ms_(\d+)\r?$/m.exec(result.stderr)
      assert(measured, 'native_probe_work_time_missing')
      times.work_ms = Number(measured[1])
      assert(times.work_ms <= 10000, 'native_probe_work_10000ms_limit_exceeded')
    }
    return result
  } catch (error) {
    throw new Error('native_powershell_phase_' + phase, { cause: error })
  } finally {
    // 只输出固定工具选择、架构和时长；不输出账户、PID、参数、系统正文或stdin数据。
    const elapsedMs = elapsed()
    let toolArch = 'unknown'
    let toolMachine: number | undefined
    try {
      // 操作结束后才只读PE，避免诊断提前预热系统可执行文件或计入功能耗时。
      const image = readFileSync(plan.executable)
      const header = image.readUInt32LE(0x3c)
      if (image.readUInt32LE(header) === 0x00004550) {
        toolMachine = image.readUInt16LE(header + 4)
        toolArch =
          toolMachine === 0xaa64 ? 'arm64' : toolMachine === 0x8664 ? 'x64' : toolMachine === 0x14c ? 'x86' : 'unknown'
      }
    } catch {
      // 工具不存在或不是可读PE时保留原操作错误，不让附加诊断覆盖其结果。
    }
    let scriptStatementObserved = false
    let scriptFirstStatementMs: number | undefined
    try {
      const recorded = readFileSync(firstStatement, 'utf8')
      scriptStatementObserved = /^\d+$/.test(recorded)
      if (scriptStatementObserved) {
        scriptFirstStatementMs = Number(recorded) - beganWall
      }
    } catch {
      // 没有首句文件与没有stderr标记分别保留，不能据单一流推断未运行。
    }
    process.stderr.write(
      JSON.stringify({
        scope: 'readonly-powershell-timing',
        tool: 'System32/WindowsPowerShell/v1.0/powershell.exe',
        bunArch: process.arch,
        toolArch,
        toolMachine,
        elapsedMs,
        times,
        scriptStatementObserved,
        scriptFirstStatementMs
      }) + '\n'
    )
    rmSync(diagnosticDirectory, { recursive: true, force: true })
  }
}

// POSIX仍在原十秒截止时终止；只继续观察同一个失败子进程，不重试、不重新解释为成功。
async function nativeProbe(plan: CommandPlan, start: typeof spawn = spawn, observationMs = 35000) {
  // 反例只能缩短测试诊断等待，不能扩大默认上限或改变生产回收期限。
  assert(observationMs > 0 && observationMs <= 35000)
  const began = performance.now()
  const times: Record<string, number> = {}
  let child: ChildProcess | undefined
  let release!: () => void
  const closed = new Promise<void>(
    /* 只由真实close事件确认回收。 */ (resolve) => {
      release = resolve
    }
  )
  let killAccepted: boolean | undefined
  let exitCode: number | null = null
  let signal: string | null = null
  const run = createSystemCommandRunner({
    start: /* 观察当前直接工具对象，不按PID操作，也不启动旁路观察器。 */ ((
      file: string,
      args: readonly string[],
      options: SpawnOptions
    ) => {
      // 事件、终止请求和实际回收共用同一单调时钟。
      const elapsed = () => Math.round(performance.now() - began)
      child = start(file, args, options)
      const kill = child.kill.bind(child)
      child.kill = /* 保留原终止请求和返回值，不重发信号。 */ (requested) => {
        times.kill_requested = elapsed()
        killAccepted = kill(requested)
        return killAccepted
      }
      child.once(
        'spawn',
        /* 系统已接受进程，不等于原生解析已完成。 */ () => {
          times.spawn = elapsed()
        }
      )
      child.stdout?.once(
        'data',
        /* 只记首个输出时刻，不记录临时路径或系统正文。 */ () => {
          times.first_stdout = elapsed()
        }
      )
      child.stderr?.once(
        'data',
        /* 错误流与退出阶段独立记录。 */ () => {
          times.first_stderr = elapsed()
        }
      )
      child.once(
        'exit',
        /* 原始退出码与信号只来自该子进程事件。 */ (code, received) => {
          times.exit = elapsed()
          exitCode = code
          signal = received
        }
      )
      child.once(
        'close',
        /* 退出后还须确认输出管道真正关闭。 */ () => {
          times.close = elapsed()
          release()
        }
      )
      return child
    }) as typeof spawn
  })
  let result: CommandResult | undefined
  let failure: unknown
  try {
    result = await run(plan)
  } catch (error) {
    failure = error
    // 原操作失败已确定；晚到close只用于区分延迟回收与仍未知，绝不能把失败洗成通过。
    await new Promise<void>(
      /* 诊断总计至多35秒，生产回收预算仍为一秒。 */ (resolve) => {
        const timer = setTimeout(resolve, Math.max(0, observationMs - (performance.now() - began)))
        void closed.then(
          /* 同一子进程完成时及时取消诊断计时器。 */ () => {
            clearTimeout(timer)
            resolve()
          }
        )
      }
    )
  } finally {
    process.stderr.write(
      JSON.stringify({
        scope: 'readonly-native-process',
        tool: plan.executable,
        platform: process.platform,
        arch: process.arch,
        elapsedMs: Math.round(performance.now() - began),
        times,
        killAccepted,
        exitCode,
        signal,
        exitObserved: times.exit !== undefined,
        closeObserved: times.close !== undefined,
        exitProperty: child?.exitCode ?? null,
        signalProperty: child?.signalCode ?? null
      }) + '\n'
    )
  }
  if (times.exit === undefined || times.close === undefined) {
    const unconfirmed = new SystemCommandError('service_recovery_required', 'cleanup_unknown')
    unconfirmed.cause = failure
    throw unconfirmed
  }
  if (result === undefined) {
    throw failure
  }
  return result
}

// 原生解析器是宿主自带的系统工具；容器和精简镜像可能没有它，此时无从验证，显式跳过而不是失败。
const nativeParser: Partial<Record<NodeJS.Platform, string>> = {
  linux: '/usr/bin/systemd-analyze',
  darwin: '/usr/bin/plutil'
}
const parserMissing = nativeParser[process.platform] !== undefined && !existsSync(nativeParser[process.platform]!)

test(
  '实际宿主原生解析器接受开机声明且不执行注册或启动',
  // 工具及诊断总界限35秒，留两秒回收余量；Windows功能十秒，POSIX操作十秒保持独立。
  { timeout: 37000, skip: parserMissing ? '宿主没有原生解析器' : false },
  /* 一个原生平台只证明自己的格式解析能力。 */ async () => {
    const platform = process.platform
    assert(['linux', 'darwin', 'win32'].includes(platform))
    const spec = {
      ...sampleSpec(platform as 'linux' | 'darwin' | 'win32'),
      executable: process.execPath,
      ...(platform === 'win32' ? { account: userInfo().username } : {})
    }
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-service-parse-'))
    try {
      if (platform === 'win32') {
        // 在生产authorize分支内复用同一COM连接检查格式，不另起第二个PowerShell冷启动。
        const formatAssertions = `
[IO.File]::WriteAllText($p.PhasePath,'input_read')
if (!$env:USERPROFILE -or !$env:TEMP) { exit 2 }
[IO.File]::WriteAllText($p.PhasePath,'environment_ready')
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($p.PhasePath,'encoding_set')
$xml=[IO.File]::ReadAllText($p.XmlPath,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($p.PhasePath,'xml_read')
$null=[object]::new()
[IO.File]::WriteAllText($p.PhasePath,'clr_ready')
[IO.File]::WriteAllText($p.PhasePath,'connected')
$t=$s.NewTask(0)
[IO.File]::WriteAllText($p.PhasePath,'definition_created')
$t.XmlText=$xml
[IO.File]::WriteAllText($p.PhasePath,'xml_parsed')
$t.Principal.LogonType=2
$sid=$t.Principal.UserId
if ($sid -notmatch '^S-1-') { $sid=([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
if ($t.Triggers.Count -ne 1 -or $t.Triggers.Item(1).Type -ne 8 -or $sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $t.Principal.LogonType -ne 2) { exit 1 }
if ($t.Actions.Count -ne 1 -or $t.Settings.ExecutionTimeLimit -ne 'PT0S' -or !$t.Settings.AllowDemandStart) { exit 1 }
# 系统登记的子项顺序和缺省值不改变执行；不同参数、提权及额外动作仍必须拒绝。
$reference=declaration $t
[xml]$reordered=$t.XmlText
$ns=[Xml.XmlNamespaceManager]::new($reordered.NameTable)
$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
foreach ($node in @($reordered.SelectNodes('/t:Task/t:Principals/t:Principal/t:RunLevel | /t:Task/t:Triggers/t:BootTrigger/t:Enabled',$ns))) { $null=$node.ParentNode.RemoveChild($node) }
$root=$reordered.DocumentElement
$null=$root.AppendChild($root.SelectSingleNode('t:Triggers',$ns))
$copy=$s.NewTask(0)
$copy.XmlText=$reordered.OuterXml
if ((declaration $copy) -cne $reference) { exit 1 }
$copy.Principal.RunLevel=1
if ((declaration $copy) -ceq $reference) { exit 1 }
$copy.Principal.RunLevel=0
$copy.Actions.Item(1).Arguments += ' --foreign'
if ((declaration $copy) -ceq $reference) { exit 1 }
$null=$copy.Actions.Create(0)
try { $null=declaration $copy; exit 1 } catch { if ($_.Exception.Message -cne 'service_conflict') { throw } }
[Console]::Error.WriteLine('rovloom_probe_validated')
[IO.File]::WriteAllText($p.PhasePath,'validated')
`
        // 与生产一致使用EncodedCommand及stdin JSON，XML仍从自有UTF-8文件读取；不执行临时脚本文件。
        const xmlFile = join(directory, 'task.xml')
        const phaseFile = join(directory, 'phase.txt')
        writeFileSync(xmlFile, renderDefinition(spec), 'utf8')
        const result = await taskCall(
          /* 仍执行生产固定JSON桥，只在已授权分支插入常量格式断言；路径仍作为stdin数据。 */ async (plan) => {
            const script = Buffer.from(plan.args.at(-1)!, 'base64').toString('utf16le')
            const authorization = "if ($p.op -eq 'authorize') { emit @{ok=$true}; exit 0 }"
            assert.equal(script.split(authorization).length, 2)
            const combined = script.replace(
              authorization,
              `if ($p.op -eq 'authorize') { ${formatAssertions} emit @{ok=$true}; [Console]::Error.WriteLine('rovloom_probe_work_ms_' + $rovloomProbeWork.ElapsedMilliseconds); exit 0 }`
            )
            return phaseTiming('windows.scheduler.parse', () =>
              bridgeProbe({
                ...plan,
                args: [...plan.args.slice(0, -1), Buffer.from(combined, 'utf16le').toString('base64')],
                input: JSON.stringify({ ...JSON.parse(plan.input!), XmlPath: xmlFile, PhasePath: phaseFile })
              })
            )
          },
          'authorize',
          'gateway'
        ).catch(
          /* 失败只报告固定阶段，临时诊断随 fixture 清理，不反射路径或系统错误正文。 */ (error) => {
            let phase = 'not_started'
            try {
              const value = readFileSync(phaseFile, 'utf8')
              if (
                [
                  'input_read',
                  'environment_ready',
                  'encoding_set',
                  'xml_read',
                  'clr_ready',
                  'connecting',
                  'connected',
                  'definition_created',
                  'xml_parsed',
                  'validated'
                ].includes(value)
              ) {
                phase = value
              }
            } catch {
              // 缺少文件阶段时仍保留固定stderr进度及工具cause，不能直接断言脚本未启动。
            }
            throw new Error('native_format_phase_' + phase, { cause: error })
          }
        )
        assert.deepEqual(result, { ok: true })
        assert.equal(readFileSync(phaseFile, 'utf8'), 'validated')
      } else {
        const file = join(directory, platform === 'linux' ? 'rovloom-connector.service' : 'io.rovloom.connector.plist')
        writeFileSync(file, renderDefinition(spec))
        const result = await phaseTiming('service.definition.parse', () =>
          nativeProbe({
            executable: platform === 'linux' ? '/usr/bin/systemd-analyze' : '/usr/bin/plutil',
            args: platform === 'linux' ? ['verify', '--man=no', file] : ['-lint', file],
            timeout: 10000
          })
        )
        assert.equal(result.code, 0, result.stderr)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  '真实工具缺少exit或close均不能把回收未确认伪报成预期超时',
  /* 只屏蔽本次真实空转子进程的一个事件；不修改全局ChildProcess或其他命令。 */ async () => {
    for (const suppressed of ['exit', 'close'] as const) {
      const observed = { exit: false, close: false }
      const start = /* 返回同一个真实子进程，在事件交付边界制造独审反例。 */ ((
        file: string,
        args: readonly string[],
        options: SpawnOptions
      ) => {
        assert(args.includes('setInterval(() => {}, 1000)'))
        const child = spawn(file, args, options)
        const emit = child.emit.bind(child)
        child.emit = /* 先记录Bun确实报告终态，再只扣留指定事件，实际进程仍正常回收。 */ (
          event: string | symbol,
          ...values: unknown[]
        ) => {
          if (event === 'exit' || event === 'close') {
            observed[event] = true
          }
          return event === suppressed ? false : emit(event, ...values)
        }
        return child
      }) as typeof spawn
      await assert.rejects(
        /* 原操作仍25ms超时、生产仍一秒回收；仅将反例诊断等待缩短到1.5秒。 */ () =>
          nativeProbe(
            { executable: process.execPath, args: ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'], timeout: 25 },
            start,
            1500
          ),
        /* 缺任一终态必须使用回收未确认，原始超时作为cause保留。 */ (error: unknown) => {
          assert(error instanceof SystemCommandError)
          assert.equal(error.code, 'service_recovery_required')
          assert.equal(error.phase, 'cleanup_unknown')
          assert(error.cause instanceof SystemCommandError)
          assert.equal(error.cause.code, 'service_timeout')
          return true
        }
      )
      assert.deepEqual(observed, { exit: true, close: true })
    }
  }
)

test(
  '只读工具超时保持失败，真实退出和close也不能洗成成功',
  { timeout: 37000 },
  /* 只启动自有Bun空转子进程；必须观察到回收，未知退出仍让本测试失败。 */ async () => {
    await assert.rejects(
      /* 用短操作预算触发同一真实终止/close路径，不注册或启动服务。 */ () =>
        nativeProbe({
          executable: process.execPath,
          args: ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'],
          timeout: 25
        }),
      { code: 'service_timeout' }
    )
  }
)
