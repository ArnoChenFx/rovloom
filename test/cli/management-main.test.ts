// 唯一main的真实管理入口/HTTP/Store验收；配置、身份、证书和业务种子均为短期合成fixture。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { openGatewayState } from '../../src/runtime/state.js'
import { createManagementHttpRead } from '../../src/webui/http-client.js'
import { createManagementWriteClient } from '../../src/webui/write-client.js'
import { createDeviceManagementFlow } from '../../src/webui/write-flow.js'
import { managementSourceFixture, managementProof, mcpProof } from './management-source-fixture.js'
import { buildManagementAssets } from './management-assets-fixture.js'

before(buildManagementAssets)

test(
  '唯一main从独立私有来源交付真实WebUI，Cookie/CSRF确认后写入Store并即时响应来源撤销',
  /** 实际HTTP和原管理写客户端无后端成功stub；人工SQL种子不构成真实配对或凭据发行。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    const built = process.env.ROVLOOM_TEST_BUILT_CLI === '1'
    const entry = fileURLToPath(
      new URL(built ? '../../dist/src/cli/main.js' : '../../src/cli/main.ts', import.meta.url)
    )
    const assets = fileURLToPath(new URL('../../dist/webui/', import.meta.url))
    let savedAssets: string | undefined
    let assetsHeld = false
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    let writer: ReturnType<typeof createManagementWriteClient> | undefined
    let flow: ReturnType<typeof createDeviceManagementFlow> | undefined
    let output = ''
    let diagnostic = ''
    try {
      const certificate = spawnSync(
        '/usr/bin/openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=management-fixture',
          '-addext',
          'subjectAltName=IP:127.0.0.1',
          '-out',
          join(f.refs, 'fixture_tls.cert.pem'),
          '-keyout',
          join(f.refs, 'fixture_tls.key.pem')
        ],
        { stdio: 'ignore' }
      )
      assert.equal(certificate.status, 0)
      chmodSync(join(f.refs, 'fixture_tls.cert.pem'), 0o600)
      chmodSync(join(f.refs, 'fixture_tls.key.pem'), 0o600)
      const initial = openGatewayState({
        state_directory: f.state,
        changed: /** 本例没有设备连接或原生实例。 */ () => {}
      })
      initial.close()
      const seed = new DatabaseSync(join(f.state, 'gateway.db'))
      try {
        seed
          .prepare('INSERT INTO machines(machine_id,name,status,credential_hash) VALUES(?,?,?,?)')
          .run(
            f.target.machine_id,
            'before_fixture',
            'offline',
            createHash('sha256').update('synthetic_not_issued').digest('hex')
          )
      } finally {
        seed.close()
      }
      if (built) {
        // 产物入口必须使用同次构建的内嵌资源，移走外部webui后仍然可用。
        savedAssets = join(mkdtempSync(join(dirname(assets), '.management-assets-held-')), 'webui')
        renameSync(assets, savedAssets)
        assetsHeld = true
      }
      child = spawn(process.execPath, ['--no-env-file', entry, 'gateway', '--config', f.configPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      exited = once(child, 'exit')
      void exited.catch(/** 启动错误由本测试主路径处理，不产生逃逸拒绝。 */ () => {})
      child.stdout!.on(
        'data',
        /** 角色stdout应为空；只保存本例少量诊断。 */ (bytes) => {
          output += bytes
        }
      )
      child.stderr!.on(
        'data',
        /** 不输出配置或证明，失败也只检查角色固定诊断。 */ (bytes) => {
          diagnostic += bytes
        }
      )
      let plain: Response | undefined
      for (let attempt = 0; attempt < 40; attempt++) {
        if (child.exitCode !== null) {
          break
        }
        try {
          plain = await fetch(f.origin)
          break
        } catch {
          await new Promise(/** 只等待本例listener启动，不提交业务或原生请求。 */ (resolve) => setTimeout(resolve, 25))
        }
      }
      assert(plain, 'fixture management listener must start')
      assert.equal(plain.status, 401)
      assert.match(plain.headers.get('www-authenticate')!, /^Basic realm="Rovloom management"/)
      assert.equal(plain.headers.get('set-cookie'), null)
      const denied = await fetch(f.origin, { headers: { authorization: 'Bearer ' + mcpProof } })
      assert.equal(denied.status, 401)
      const page = await fetch(f.origin, {
        headers: {
          authorization: 'Basic ' + Buffer.from(f.lease.caller.principal_id + ':' + managementProof).toString('base64')
        }
      })
      assert.equal(page.status, 200)
      const html = await page.text()
      assert(html.includes('browser.js') && html.includes('manage.css'))
      const cookie = /^rovloom_management=[\w-]{43}/.exec(page.headers.get('set-cookie')!)![0]!
      const csrf = /name="rovloom-management-bootstrap" content="([\w-]{43})"/.exec(html)![1]!
      for (const privateValue of [
        managementProof,
        mcpProof,
        cookie,
        f.lease.management_session_ref,
        f.lease.caller.principal_id
      ]) {
        assert(!html.includes(privateValue))
      }
      assert.equal((await fetch(f.origin + '/browser.js')).status, 200)
      const fetcher = /** Bun模拟浏览器同源cookie/Origin；真实handler和持久确认逻辑保持不变。 */ (
        path: string,
        init: RequestInit
      ) => {
        const headers = new Headers(init.headers)
        headers.set('cookie', cookie)
        headers.set('origin', f.origin)
        return fetch(f.origin + path, { ...init, headers })
      }
      const read = createManagementHttpRead(fetcher)
      assert.equal(
        (await read('devices_get', { machine_id: f.target.machine_id }, new AbortController().signal)).name,
        'before_fixture'
      )
      const missingCsrf = await fetcher('/admin/v1/actions/history_open', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' }
      })
      assert.equal(missingCsrf.status, 400)
      const invalidCsrf = await fetcher('/admin/v1/actions/history_open', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json', 'x-rovloom-csrf': 'x'.repeat(43) }
      })
      assert.equal(invalidCsrf.status, 403)
      writer = createManagementWriteClient({ csrf: /** 仅使用原HTML交付的内存CSRF。 */ async () => csrf, fetcher })
      flow = createDeviceManagementFlow({ transport: writer })
      assert.equal(
        (await flow.prepare({ action: 'device_rename', machine_id: f.target.machine_id, name: 'after_fixture' })).phase,
        'awaiting_confirmation'
      )
      assert.equal((await flow.confirm()).phase, 'committed')
      assert.equal(
        (await read('devices_get', { machine_id: f.target.machine_id }, new AbortController().signal)).name,
        'after_fixture'
      )
      f.save(f.sourcePath, {
        ...f.source,
        sessions: [{ ...f.source.sessions[0]!, credential_sha256: '2'.repeat(64) }]
      })
      await assert.rejects(
        read('devices_get', { machine_id: f.target.machine_id }, new AbortController().signal),
        /unauthenticated/
      )
      f.save(f.sourcePath, f.source)
      await assert.rejects(
        read('devices_get', { machine_id: f.target.machine_id }, new AbortController().signal),
        /unauthenticated/
      )
      child.kill('SIGTERM')
      await exited
      assert.equal(child.exitCode, 0)
      child = undefined
      const verify = new DatabaseSync(join(f.state, 'gateway.db'), { readOnly: true })
      try {
        assert.equal(
          verify.prepare('SELECT name FROM machines WHERE machine_id=?').get(f.target.machine_id)!.name,
          'after_fixture'
        )
      } finally {
        verify.close()
      }
      assert.equal(output, '')
      // 启动只新增宿主上报的管理页地址行；除此之外不得有任何诊断。
      assert.match(diagnostic, /^dashboard_listening http:\/\/127\.0\.0\.1:\d+\/\n$/)
    } finally {
      flow?.dispose()
      writer?.close()
      if (child && child.exitCode === null) {
        child.kill('SIGKILL')
        await exited
      }
      if (savedAssets) {
        if (assetsHeld && existsSync(savedAssets)) {
          renameSync(savedAssets, assets)
        }
        rmSync(dirname(savedAssets), { recursive: true, force: true })
      }
      f.close()
    }
  }
)
