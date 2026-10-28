// Connector 的干净重置：把本机配对状态连同原生根整体退役到 retired/<时间戳>/（保留证据与 managed 数据），
// 供 `rovloom connector --unpair` 与 `--join` 换 Gateway/换码时复用；用户自己的 Luvus/Herdr 会话与未知文件一律不动。
import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { syncParentDirectory } from '../storage/files.js'
import { ownedFile, recordedProcess } from '../storage/lock-recovery.js'
import { ownerIsDead } from '../storage/process-identity.js'
import { DISPATCH_CLAIMS_LOCK_FORMAT } from '../connector/claims.js'
import { boundedJson } from '../wire/index.js'
import { CliError, configDocument, readConfig, type ConnectorConfig } from './config.js'
import { privateDirectory } from './first-config.js'
import { cliMessages, formatMessage } from './messages.js'
import type { CliIo } from './run.js'
import { runtimeReference } from './runtime-files.js'
import { setupFileStamp, writeSetupFile } from './setup-files.js'
import type { SetupConsole } from './setup-console.js'

// 六份配对记录全部绑定旧 attempt/machine，留下任何一份都会让新 join 在"已配对/原生已准备"处短路。
const PAIRING_FILES = ['device', 'pairing', 'pairing-claim', 'providers', 'native-setup', 'herdr-setup'] as const
// 隔离 Luvus 的状态根/HOME/工作目录与隔离 Herdr 的私有根，以及两者共用的控制目录（root 记录与 claim 账本）。
// managed 模式重新配对要求这些目录回到空白（initializeManagedLuvusRoot 的 not_blank 门禁），因此必须一并退役。
const PAIRING_DIRECTORIES = ['control', 'n', 'h', 'w', 'hr'] as const
// 两个 provider 的 claim 账本锁共用同一格式；锁里记录持有者进程身份，只有能证明它已死才继续。
const CLAIM_LOCKS = ['control/luvus-claims.db.lock', 'hr/control/claims.db.lock'] as const

/** 任何半成品记录或隔离根都需要参与新 join 的恢复判断。 */
export function hasPairingState(directory: string): boolean {
  return (
    PAIRING_FILES.some((reference) => existsSync(runtimeReference(directory, reference))) ||
    PAIRING_DIRECTORIES.some((name) => existsSync(join(directory, name)))
  )
}

/** 只把普通文件当记录、真实目录当隔离状态根；链接、设备文件或未知形态一律不动。 */
function entry(path: string): 'file' | 'directory' | undefined {
  try {
    const info = lstatSync(path)
    if (info.isFile()) {
      return 'file'
    }
    return info.isDirectory() ? 'directory' : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw new CliError('config_unreadable')
  }
}

/**
 * 有活着持有者的 claim 锁说明该 Connector 仍在运行；退役它的账本会留下一个已消失的 inode，
 * 所以先拒绝并让所有者停掉它，而不是在运行中拆掉状态。
 */
function assertConnectorIdle(stateDir: string): void {
  for (const name of CLAIM_LOCKS) {
    const path = join(stateDir, name)
    if (ownedFile(path) !== true) {
      continue
    }
    try {
      const bytes = readFileSync(path)
      if (bytes.length === 0 || bytes.length > 1024) {
        continue
      }
      const recorded = recordedProcess(JSON.parse(bytes.toString('utf8')), DISPATCH_CLAIMS_LOCK_FORMAT)
      if (recorded && !ownerIsDead(recorded)) {
        throw new CliError('configuration_required')
      }
    } catch (error) {
      // 无法判断锁归属时保持 fail-closed；格式不符的旧锁不阻止本机所有者显式重置。
      if (error instanceof CliError) {
        throw error
      }
    }
  }
}

/** 退役目录名取 UTC 秒级时间戳；同名已存在时加序号，不覆盖上一次退役的证据。 */
function retireStamp(stateDir: string): string {
  const base = new Date()
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z')
  for (let index = 0; ; index++) {
    const name = index === 0 ? base : base + '-' + index
    if (entry(join(stateDir, 'retired', name)) === undefined) {
      return name
    }
  }
}

/**
 * 把 Connector 自己的固定配对状态整体搬入 retired/<时间戳>/（同一文件系统内原子 rename，两侧目录落盘）。
 * 用户自己的 Luvus/Herdr 会话、Gateway 侧记录与未知文件一律不动；没有任何可退役条目时返回 undefined。
 */
export function retirePairingState(config: ConnectorConfig, console: SetupConsole): string | undefined {
  console.assertOwner()
  assertConnectorIdle(config.state_dir)
  const moves: { source: string; target: string }[] = []
  const root = join(config.state_dir, 'retired', retireStamp(config.state_dir))
  for (const reference of PAIRING_FILES) {
    const source = runtimeReference(config.state_dir, reference)
    if (entry(source) === 'file') {
      moves.push({ source, target: join(root, 'managed', reference + '.json') })
    }
  }
  for (const name of PAIRING_DIRECTORIES) {
    const source = join(config.state_dir, name)
    if (entry(source) === 'directory') {
      moves.push({ source, target: join(root, name) })
    }
  }
  if (moves.length === 0) {
    return undefined
  }
  try {
    privateDirectory(join(config.state_dir, 'retired'))
    privateDirectory(root)
    for (const move of moves) {
      privateDirectory(dirname(move.target))
      renameSync(move.source, move.target)
      // 搬移两侧的目录项都要进入持久边界；中途失败时已搬走的条目留在退役目录里可人工核查。
      syncParentDirectory(move.target)
      syncParentDirectory(move.source)
    }
  } catch (error) {
    throw error instanceof CliError ? error : new CliError('config_unreadable')
  }
  return root
}

/**
 * CLI 的 `--unpair`：只读现有配置（缺失即按默认生成，保持幂等），退役全部本地配对状态并清空 Gateway 地址；
 * 之后任意 Gateway 的 `--join` 都从零开始。非交互、无确认。
 */
export async function handleConnectorUnpair(path: string, io: CliIo): Promise<number> {
  const config = readConfig(path)
  if (config.role !== 'connector') {
    throw new CliError('config_role_mismatch')
  }
  if (io.signal.aborted) {
    return 0
  }
  const console: SetupConsole = {
    io,
    show: (text) => {
      io.stderr.write(text)
    },
    confirm: async () => true,
    assertOwner: () => {}
  }
  const retired = retirePairingState(config, console)
  privateDirectory(join(config.state_dir, 'managed'))
  if (config.gateway_url !== '' || retired !== undefined) {
    // 清空地址让下一次 join 重新提问目标；写入前核对磁盘文件仍与内存配置一致。
    if (boundedJson(configDocument(readConfig(path))) !== boundedJson(configDocument(config))) {
      throw new CliError('config_changed')
    }
    writeSetupFile(
      path,
      JSON.stringify({ ...configDocument(config), gateway: { url: '' } }, null, 2) + '\n',
      true,
      setupFileStamp(path)
    )
  }
  io.stderr.write(
    retired === undefined
      ? cliMessages(io.language)['unpair.empty']
      : formatMessage(cliMessages(io.language)['unpair.completed'], { retired })
  )
  return 0
}
