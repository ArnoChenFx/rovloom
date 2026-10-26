// 仅操作自有临时目录及合成账本，验证普通跨平台文件与已有持久化语义。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivate, ensurePrivateDirectory, managedBytes, readPrivateBytes } from '../../src/storage/files.js'
import { snapshotDirectory } from '../../src/storage/snapshot-directory.js'
import { readOrCreateRoleConfig } from '../../src/cli/first-config.js'
import { readConfig } from '../../src/cli/config.js'
import { readRuntimeJson } from '../../src/cli/runtime-files.js'
import { setupFileStamp, writeSetupFile } from '../../src/cli/setup-files.js'
import { Store } from '../../src/store.js'
import { connected, management, options } from './helpers.js'

declare const Bun: { gc(full: boolean): void }

// 使用真实系统临时根，清理只涉及本例创建的对象。
function temporary(check: (directory: string) => void): void {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-file-platform-'))
  try {
    check(directory)
  } finally {
    // 业务断言及Store.close已结束，再释放Bun未回收的prepared statement包装；不绕过写锁或事务。
    if (process.platform === 'win32') {
      Bun.gc(true)
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

test(
  '配置及状态可用普通目录和硬链接，读取保持字节与现有权限',
  /* 实际调用正式读取器。 */ () => {
    temporary(
      /* 所有权限变更仅用于本例新建对象。 */ (root) => {
        const directory = join(root, 'state')
        mkdirSync(directory, { mode: 0o755 })
        ensurePrivateDirectory(directory)
        const path = join(directory, 'value.json')
        writeFileSync(path, '{"value":"synthetic"}', { mode: 0o644 })
        const modes = [statSync(directory).mode, statSync(path).mode]
        assert.deepEqual(readRuntimeJson(path), { value: 'synthetic' })
        const hard = join(directory, 'hard.json')
        linkSync(path, hard)
        assert.deepEqual(readRuntimeJson(hard), { value: 'synthetic' })
        assert.deepEqual([statSync(directory).mode, statSync(path).mode], modes)
        const config = join(directory, 'gateway.json')
        const created = readOrCreateRoleConfig('gateway', config, { home: root, platform: process.platform })
        const before = readFileSync(config)
        const inode = statSync(config).ino
        const mode = statSync(config).mode
        linkSync(config, join(directory, 'duplicate.json'))
        assert.deepEqual(readConfig(config), created)
        readOrCreateRoleConfig('gateway', config)
        assert.deepEqual(readFileSync(config), before)
        assert.equal(statSync(config).ino, inode)
        assert.equal(statSync(config).mode, mode)
      }
    )
  }
)

test(
  '普通目录链接可读取，容量统计不递归进入目录链接形成的环',
  /* Windows使用无需提权的目录junction。 */ () => {
    temporary(
      /* 链接目标和别名都属于本例临时根。 */ (root) => {
        const directory = join(root, 'state')
        mkdirSync(directory)
        createPrivate(join(directory, 'value.json'), '{"synthetic":true}')
        const alias = join(root, 'alias')
        symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
        assert.deepEqual(readRuntimeJson(join(alias, 'value.json')), { synthetic: true })
        symlinkSync(root, join(directory, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir')
        assert.equal(managedBytes(root), Buffer.byteLength('{"synthetic":true}'))
        if (process.platform !== 'win32') {
          const link = join(root, 'value-link.json')
          symlinkSync(join(directory, 'value.json'), link)
          assert.deepEqual(readRuntimeJson(link), { synthetic: true })
          assert.equal(managedBytes(root), 2 * Buffer.byteLength('{"synthetic":true}'))
        }
      }
    )
  }
)

test(
  '有界文件及严格JSON继续拒绝目录、超限、坏编码和重复字段',
  /* 无效输入不能触发默认配置覆盖。 */ () => {
    temporary(
      /* 每种输入只写入本例的非秘密fixture。 */ (root) => {
        const path = join(root, 'value.json')
        createPrivate(path, '{"value":1}')
        assert.throws(/* 正常文件也必须遵循实际字节预算。 */ () => readPrivateBytes(path, 4))
        assert.throws(/* 目录不是JSON文件。 */ () => readPrivateBytes(root, 1024))
        for (const content of ['{"value":1,"value":2}', Buffer.from([0xff]), 'x'.repeat(16_385)]) {
          writeFileSync(path, content)
          assert.throws(/* 运行状态与角色读取都保留严格内容校验。 */ () => readRuntimeJson(path))
          assert.throws(/* 损坏的已有角色文件不能恢复成默认值。 */ () => readOrCreateRoleConfig('gateway', path))
          assert.deepEqual(readFileSync(path), Buffer.from(content))
        }
      }
    )
  }
)

test(
  '配置原子发布不覆盖已有文件，内容冲突拒绝，更新保留普通权限',
  /* 原子写入及冲突检查都使用真实文件。 */ () => {
    temporary(
      /* 临时发布文件只应在本例操作期间存在。 */ (root) => {
        const path = join(root, 'setup.json')
        writeFileSync(path, '{"revision":1}', { mode: 0o644 })
        const mode = statSync(path).mode & 0o777
        const stamp = setupFileStamp(path)
        assert.throws(/* 首次发布不得覆盖已有内容。 */ () => writeSetupFile(path, '{"revision":2}'))
        assert.equal(readFileSync(path, 'utf8'), '{"revision":1}')
        writeFileSync(path, '{"revision":3}')
        assert.throws(/* 拒绝覆盖读取后发生的实际编辑。 */ () => writeSetupFile(path, '{"revision":2}', true, stamp), {
          code: 'config_changed'
        })
        writeSetupFile(path, '{"revision":4}', true, setupFileStamp(path))
        assert.equal(readFileSync(path, 'utf8'), '{"revision":4}')
        assert.equal(statSync(path).mode & 0o777, mode)
        assert.deepEqual(readdirSync(root), ['setup.json'])
      }
    )
  }
)

test(
  '可搜索祖先及可写不可列举父目录允许配置与SQLite，权限不变',
  /* POSIX权限fixture不切换身份或修改用户目录。 */ () => {
    if (process.platform === 'win32') {
      return
    }
    temporary(
      /* 仅为清理恢复本例新建目录的权限。 */ (root) => {
        const search = join(root, 'search')
        const directory = join(search, 'state')
        ensurePrivateDirectory(directory)
        const expectedBackups = join(realpathSync(root), 'search', 'state') + '.backups'
        chmodSync(search, 0o111)
        chmodSync(directory, 0o300)
        try {
          if (process.getuid?.() !== 0) {
            assert.throws(/* 父目录确实无法列举，按已知路径的写入仍正常。 */ () => readdirSync(directory), {
              code: 'EACCES'
            })
          }
          const path = join(directory, 'gateway.json')
          assert.equal(snapshotDirectory(join(directory, 'gateway.db')), expectedBackups)
          readOrCreateRoleConfig('gateway', path, { home: root, platform: process.platform })
          assert.equal(readConfig(path).role, 'gateway')
          new Store(join(directory, 'gateway.db')).close()
          new Store(join(directory, 'gateway.db')).close()
          assert.equal(statSync(search).mode & 0o777, 0o111)
          assert.equal(statSync(directory).mode & 0o777, 0o300)
        } finally {
          chmodSync(search, 0o700)
          chmodSync(directory, 0o700)
        }
      }
    )
  }
)

test(
  '双开与残留锁均拒绝，SQLite重开保留unknown且不重派',
  /* 六平台均使用实际SQLite和离线合成设备。 */ () => {
    temporary(
      /* 真实关闭重开，不伪造持久化或命令完成。 */ (directory) => {
        const path = join(directory, 'gateway.db')
        let store = new Store(path, /* 固定账本时钟。 */ () => 100, { management })
        try {
          const device = connected(store)
          const callOptions = options({
            client_request_key: 'platform-key'
          })
          const call = store.createCall('alice', device.target, { method: 'ping' }, callOptions)
          store.dispatch('alice', call.call_id, device.epoch)
          assert.throws(/* 存活writer不可被第二个实例接管。 */ () => new Store(path), /EEXIST/)
          store.close()
          store = new Store(path, /* 沿用原时钟，重开不能重派在途调用。 */ () => 100, { management })
          assert.equal(store.call('alice', call.call_id).state, 'outcome_unknown')
          assert.equal(store.createCall('alice', device.target, { method: 'ping' }, callOptions).call_id, call.call_id)
          assert.throws(/* unknown调用不能再次派发。 */ () => store.dispatch('alice', call.call_id, device.epoch))
          store.close()
          createPrivate(path + '.lock', 'synthetic-crash-lock')
          assert.throws(/* 崩溃锁不自动删除。 */ () => new Store(path), /EEXIST/)
          assert.equal(existsSync(path + '.lock'), true)
        } finally {
          store.close()
        }
      }
    )
  }
)
