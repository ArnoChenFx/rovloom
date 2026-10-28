// 验证结果游标在长下载、重试及并发身份下的容量与完整性；原生执行明确由组件端口替代。
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { canonical, digest } from '../../src/contracts.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import type { ReplyData, ServiceContext, ToolArguments } from '../../src/mcp/types.js'
import { DEFAULT_LIMITS } from '../../src/connector/luvus/contract/index.js'
import { LIMITS } from '../../src/wire/index.js'
import { projectionFixture } from './runtime-service-fixture.js'

// 构造恰好达到指定字节数的合法 UTF-8 JSON，页必须还原完整响应及多字节字符。
function responseOfSize(bytes: number) {
  const response = { id: 'synthetic_native', result: { value: '中🙂' } }
  response.result.value += 'x'.repeat(bytes - Buffer.byteLength(canonical(response)))
  return response
}

// 仅隔离门面容量的完整正文切片端口；真实Store/Router授权及过期另由本文件其余用例与结果层回归覆盖。
function bufferedResultFixture(content: Buffer) {
  const f = projectionFixture()
  const hash = digest(content.toString())
  let reads = 0
  const service = new RuntimeGatewayService({
    ...f,
    runtime: {
      ...f.runtime,
      results: {
        ...f.runtime.results,
        read: /** 返回完整fixture的真实切片，不跳过或伪造任何页；身份仍来自真实请求作用域。 */ (
          id,
          offset = 0,
          bytes = 65_536
        ) => {
          assert.equal(f.runtime.principal().id, 'alice')
          assert.equal(id, 'result_fixture')
          reads++
          return {
            result_id: id,
            data: content.subarray(offset, offset + bytes).toString('base64'),
            encoding: 'base64' as const,
            bytes: content.length,
            hash,
            expires: 1_060_000,
            next_cursor: Math.min(content.length, offset + bytes),
            eof: offset + bytes >= content.length
          }
        }
      }
    }
  })
  return {
    ...f,
    service,
    reads: /** 仅计量实际逐页请求，防止以跳页伪造完成。 */ () => reads,
    close: /** 两个门面共用真实请求作用域与Store，由原fixture统一回收。 */ () => {
      service.close()
      f.close()
    }
  }
}

describe(
  '最大原生结果的同一次默认分页下载',
  /** 连续分段仍读取全部256页，每段保留原5秒期限并共享同一下载位置。 */ () => {
    const response = responseOfSize(DEFAULT_LIMITS.object_bytes)
    const expected = Buffer.from(canonical(response))
    const hash = digest(expected.toString())
    const chunks: Buffer[] = []
    let f: ReturnType<typeof projectionFixture>
    let cursor: string | undefined
    let firstCursor: string | undefined
    let pages = 0
    let second: ReplyData['runtime_result_read'] | undefined
    before(
      /** 一次创建真实Store/Router，不在分段间重新打开句柄或重置cursor。 */ () => {
        f = projectionFixture({ response })
      }
    )
    after(
      /** 成功或失败都回收唯一下载fixture，不留跨套件资源。 */ () => {
        f?.close()
      }
    )
    for (let segment = 0; segment < 8; segment++) {
      test(
        `默认4096字节连续读取第${segment + 1}组32页`,
        /** 真实逐页读取，不快进、不替代缺失页或放宽单例期限。 */ async () => {
          assert.equal(pages, segment * 32)
          for (let index = 0; index < 32; index++) {
            const page = (
              await f.service.execute(
                'runtime_result_read',
                { result_id: 'result_fixture', ...(cursor ? { cursor } : {}) },
                f.context
              )
            ).data
            assert.equal(page.encoding, 'base64')
            assert.equal(page.total_bytes, DEFAULT_LIMITS.object_bytes)
            assert.equal(page.sha256, hash)
            assert.equal(page.expires_at, 1_060_000)
            const chunk = Buffer.from(page.chunk, 'base64')
            assert.equal(chunk.length, 4096)
            chunks.push(chunk)
            if (pages === 0) {
              firstCursor = page.next_cursor
            }
            if (pages === 1) {
              second = page
            }
            pages++
            cursor = page.next_cursor
            assert.equal(page.eof, pages === 256)
            assert.equal(cursor === undefined, pages === 256)
          }
        }
      )
    }
    test(
      '完整256页到EOF后逐字节核对原文，并重读早期cursor',
      /** 单一下载必须覆盖全部字节，后续页数不能影响旧cursor重试。 */ async () => {
        assert.equal(pages, 256)
        assert.deepEqual(Buffer.concat(chunks), expected)
        f.advance(1)
        assert(firstCursor && second)
        assert.deepEqual(
          (
            await f.service.execute(
              'runtime_result_read',
              { result_id: 'result_fixture', cursor: firstCursor },
              f.context
            )
          ).data,
          second
        )
      }
    )
  }
)

test(
  '共享Wire最大8MiB结果的2048页不累积服务游标，逐页返回实际字节',
  /** 仅替换结果页端口来隔离门面容量，完整原文存在；不声称验证原生8MiB能力。 */ async () => {
    const content = Buffer.from(JSON.stringify(responseOfSize(LIMITS.object_bytes)))
    const hash = digest(content.toString())
    const f = bufferedResultFixture(content)
    try {
      const chunks: Buffer[] = []
      let cursor: string | undefined
      do {
        const page = (
          await f.service.execute(
            'runtime_result_read',
            { result_id: 'result_fixture', ...(cursor ? { cursor } : {}) },
            f.context
          )
        ).data
        chunks.push(Buffer.from(page.chunk, 'base64'))
        assert.equal(page.sha256, hash)
        assert.equal(page.total_bytes, LIMITS.object_bytes)
        cursor = page.next_cursor
        assert.equal(page.eof, cursor === undefined)
      } while (cursor)
      assert.equal(f.reads(), 2048)
      assert.deepEqual(Buffer.concat(chunks), content)
    } finally {
      f.close()
    }
  }
)

test(
  '完成超过128次下载不占容量，EOF和同cursor重试保持原页与后继',
  /** 多个下载交错进行，旧下载与完成重试都不能阻止新下载。 */ async () => {
    const f = bufferedResultFixture(Buffer.from(canonical(responseOfSize(8_195))))
    try {
      const first = (await f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context)).data
      assert(first.next_cursor)
      const second = (
        await f.service.execute(
          'runtime_result_read',
          { result_id: 'result_fixture', cursor: first.next_cursor },
          f.context
        )
      ).data
      assert(second.next_cursor)
      f.advance(10)
      assert.deepEqual(
        (
          await f.service.execute(
            'runtime_result_read',
            { result_id: 'result_fixture', cursor: first.next_cursor },
            f.context
          )
        ).data,
        second
      )
      const eof = (
        await f.service.execute(
          'runtime_result_read',
          { result_id: 'result_fixture', cursor: second.next_cursor },
          f.context
        )
      ).data
      assert.equal(eof.eof, true)
      assert.equal(eof.next_cursor, undefined)
      for (let bytes = 4098; bytes < 4298; bytes++) {
        const start = (
          await f.service.execute('runtime_result_read', { result_id: 'result_fixture', max_bytes: bytes }, f.context)
        ).data
        assert(start.next_cursor)
        const end = (
          await f.service.execute(
            'runtime_result_read',
            { result_id: 'result_fixture', max_bytes: bytes, cursor: start.next_cursor },
            f.context
          )
        ).data
        assert.equal(end.eof, true)
      }
      assert.deepEqual(
        (
          await f.service.execute(
            'runtime_result_read',
            { result_id: 'result_fixture', cursor: second.next_cursor },
            f.context
          )
        ).data,
        eof
      )
      assert.deepEqual(
        (
          await f.service.execute(
            'runtime_result_read',
            { result_id: 'result_fixture', cursor: first.next_cursor },
            f.context
          )
        ).data,
        second
      )
    } finally {
      f.close()
    }
  }
)

test(
  '并发caller分别读取所属结果，交换cursor、结果或页大小均不能通过完整性绑定',
  /** 克隆人工历史而非签发身份凭据，真实Store、Router和异步作用域共同检查归属。 */ async () => {
    const f = projectionFixture({
      response: responseOfSize(40_000),
      mutateSeed: /** 仅在writer关闭的fixture阶段创建另一主体的历史。 */ (db) => {
        const row = db.prepare('SELECT * FROM calls').get()!
        row.call_id = 'call_bob'
        row.principal = 'bob'
        const fields = Object.keys(row)
        db.prepare(
          `INSERT INTO calls (${fields.join(',')}) VALUES (${fields.map(/** 每列独立绑定，值不拼接进SQL。 */ () => '?').join(',')})`
        ).run(...Object.values(row))
        db.prepare(
          "INSERT INTO results SELECT 'result_bob','call_bob',bytes,hash,expires FROM results WHERE result_id='result_fixture'"
        ).run()
      }
    })
    f.identities.principal = /** 明确解析两个合成caller，不能把最近主体缓存成共享身份。 */ (caller) => {
      const principal = f.current()
      return caller.principal_id === 'alice' || caller.principal_id === 'bob'
        ? { ...principal, id: caller.principal_id }
        : null
    }
    const bob: ServiceContext = { ...f.context, caller: { principal_id: 'bob' } }
    try {
      const first = await Promise.all([
        f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context),
        f.service.execute('runtime_result_read', { result_id: 'result_bob' }, bob)
      ])
      const aliceCursor = first[0]!.data.next_cursor!
      const bobCursor = first[1]!.data.next_cursor!
      for (const [result_id, cursor, context, max_bytes] of [
        ['result_fixture', aliceCursor, bob, 4096],
        ['result_bob', aliceCursor, bob, 4096],
        ['result_bob', bobCursor, f.context, 4096],
        ['result_bob', aliceCursor, f.context, 4096],
        ['result_fixture', aliceCursor, f.context, 4097]
      ] as const) {
        await assert.rejects(
          /** 所有绑定差异均在结果读取之前返回固定cursor拒绝。 */ () =>
            f.service.execute('runtime_result_read', { result_id, cursor, max_bytes }, context),
          { code: 'invalid_cursor' }
        )
      }
      const consume = /** 每个caller独立推进并重试，真实异步作用域不能串身份。 */ async (
        result_id: string,
        cursor: string,
        context: ServiceContext
      ) => {
        let current: string | undefined = cursor
        let pages = 1
        while (current) {
          const args: ToolArguments['runtime_result_read'] = { result_id, cursor: current }
          const page = (await f.service.execute('runtime_result_read', args, context)).data
          assert.deepEqual((await f.service.execute('runtime_result_read', args, context)).data, page)
          current = page.next_cursor
          pages++
        }
        assert.equal(pages, Math.ceil(40_000 / 4096))
      }
      await Promise.all([consume('result_fixture', aliceCursor, f.context), consume('result_bob', bobCursor, bob)])
    } finally {
      f.close()
    }
  }
)

test(
  'cursor位置、期限和签名篡改被拒绝，跨服务密钥及关闭不能重用',
  /** 不依赖签名成为权限，合法cursor仍必须由原实例认证。 */ async () => {
    const f = projectionFixture({ response: responseOfSize(20_000) })
    const other = new RuntimeGatewayService({ ...f, runtime: f.runtime })
    try {
      const first = (await f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context)).data
      assert(first.next_cursor)
      const [version, offset, expires, tag] = first.next_cursor.split('.') as [string, string, string, string]
      for (const cursor of [
        'result_legacy',
        `${version}.${Number(offset) + 1}.${expires}.${tag}`,
        `${version}.${offset}.${Number(expires) + 30_000}.${tag}`,
        `${version}.9007199254740992.${expires}.${tag}`,
        `${version}.0${offset}.${expires}.${tag}`,
        `${version}.${offset}.${expires}.${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`
      ]) {
        await assert.rejects(
          /** 篡改不允许通过offset、期限或非规范编码绕过HMAC。 */ () =>
            f.service.execute('runtime_result_read', { result_id: 'result_fixture', cursor }, f.context),
          { code: 'invalid_cursor' }
        )
      }
      await assert.rejects(
        /** 新服务实例不能恢复旧签名或把同一Store视为密钥来源。 */ () =>
          other.execute('runtime_result_read', { result_id: 'result_fixture', cursor: first.next_cursor }, f.context),
        { code: 'invalid_cursor' }
      )
      f.service.close()
      await assert.rejects(
        /** 显式关闭后无论有无cursor都不能交付正文。 */ () =>
          f.service.execute(
            'runtime_result_read',
            { result_id: 'result_fixture', cursor: first.next_cursor },
            f.context
          ),
        { code: 'unavailable' }
      )
    } finally {
      other.close()
      f.close()
    }
  }
)

test(
  '推进或重试不延长30秒固定期限，到期即拒绝；结果句柄期限仍是更早上界',
  /** 合成时钟推进覆盖等号边界，无真实等待或超时放宽。 */ async () => {
    const f = projectionFixture({ response: responseOfSize(20_000) })
    try {
      const start = (await f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context)).data
      f.advance(29_999)
      const args = { result_id: 'result_fixture', cursor: start.next_cursor! }
      const second = (await f.service.execute('runtime_result_read', args, f.context)).data
      assert(second.next_cursor)
      assert.deepEqual((await f.service.execute('runtime_result_read', args, f.context)).data, second)
      f.advance(1)
      for (const cursor of [start.next_cursor, second.next_cursor]) {
        await assert.rejects(
          /** 后继和重试均不能从本次读取重新获得30秒。 */ () =>
            f.service.execute('runtime_result_read', { result_id: 'result_fixture', cursor }, f.context),
          { code: 'invalid_cursor' }
        )
      }
      const restarted = (await f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context))
        .data
      assert.equal(restarted.expires_at, 1_060_000)
      f.advance(29_999)
      await f.service.execute(
        'runtime_result_read',
        { result_id: 'result_fixture', cursor: restarted.next_cursor },
        f.context
      )
      f.advance(1)
      await assert.rejects(
        /** 即使新下载仍只以实际句柄/内容截止为上界。 */ () =>
          f.service.execute(
            'runtime_result_read',
            { result_id: 'result_fixture', cursor: restarted.next_cursor },
            f.context
          ),
        { code: 'invalid_cursor' }
      )
      await assert.rejects(
        /** 无cursor也不能重建过期内容或延长原句柄。 */ () =>
          f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context),
        { code: 'content_unavailable' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  '实际句柄早于30秒到期时后继固定使用较早期限，不能以内容仍有效恢复',
  /** 只缩短人工句柄期限，正文仍保持原60秒有效期。 */ async () => {
    const f = projectionFixture({
      response: responseOfSize(20_000),
      mutateSeed: /** 在writer关闭的fixture阶段设置更早句柄截止。 */ (db) => {
        db.prepare('UPDATE results SET expires=?').run(1_005_000)
      }
    })
    try {
      const first = (await f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context)).data
      assert.equal(first.expires_at, 1_005_000)
      f.advance(4_999)
      const second = (
        await f.service.execute(
          'runtime_result_read',
          { result_id: 'result_fixture', cursor: first.next_cursor },
          f.context
        )
      ).data
      assert.equal(second.expires_at, first.expires_at)
      f.advance(1)
      for (const cursor of [first.next_cursor, second.next_cursor]) {
        await assert.rejects(
          /** 内容尚存也不能替代实际句柄和cursor的较早截止。 */ () =>
            f.service.execute('runtime_result_read', { result_id: 'result_fixture', cursor }, f.context),
          { code: 'invalid_cursor' }
        )
      }
      await assert.rejects(
        /** 首次读取不重建已过期的结果句柄。 */ () =>
          f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context),
        { code: 'content_unavailable' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  '本页是合法UTF-8时额外给出逐字节一致的text，二进制页不给',
  /** 文本形式只是附加表示：encoding 与 chunk 保持 base64 原样，重读结果必须逐字段一致。 */ async () => {
    const content = Buffer.from('{"value":"中文🙂"}', 'utf8')
    const textFixture = bufferedResultFixture(content)
    try {
      const page = (
        await textFixture.service.execute('runtime_result_read', { result_id: 'result_fixture' }, textFixture.context)
      ).data
      assert.equal(page.encoding, 'base64')
      assert.equal(page.chunk, content.toString('base64'))
      assert.equal(page.text, content.toString('utf8'))
      assert.deepEqual(Buffer.from(page.text!, 'utf8'), content)
      assert.deepEqual(
        (await textFixture.service.execute('runtime_result_read', { result_id: 'result_fixture' }, textFixture.context))
          .data,
        page
      )
    } finally {
      textFixture.close()
    }
    const binaryFixture = bufferedResultFixture(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x61]))
    try {
      const page = (
        await binaryFixture.service.execute(
          'runtime_result_read',
          { result_id: 'result_fixture' },
          binaryFixture.context
        )
      ).data
      assert.equal(page.text, undefined)
      assert.equal(page.chunk, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x61]).toString('base64'))
    } finally {
      binaryFixture.close()
    }
  }
)

test(
  '页边界切开多字节字符时该页不给text，对齐后的页恢复提供',
  /** 固定3字节页宽遍历8字节内容：只有完整落在页内的末页 ASCII 片段可给出文本。 */ async () => {
    const f = bufferedResultFixture(Buffer.from('ab🙂cd', 'utf8'))
    try {
      const first = (
        await f.service.execute('runtime_result_read', { result_id: 'result_fixture', max_bytes: 3 }, f.context)
      ).data
      assert.equal(first.text, undefined)
      assert(first.next_cursor)
      const second = (
        await f.service.execute(
          'runtime_result_read',
          { result_id: 'result_fixture', max_bytes: 3, cursor: first.next_cursor },
          f.context
        )
      ).data
      assert.equal(second.text, undefined)
      assert(second.next_cursor)
      const third = (
        await f.service.execute(
          'runtime_result_read',
          { result_id: 'result_fixture', max_bytes: 3, cursor: second.next_cursor },
          f.context
        )
      ).data
      assert.equal(third.eof, true)
      assert.equal(third.text, 'cd')
    } finally {
      f.close()
    }
  }
)

test(
  '真实Store的小型UTF-8结果单页同时返回base64与text',
  /** 经真实结果层读取合成响应，text 必须等于原文，摘要与总字节仍以原文为准。 */ async () => {
    const response = responseOfSize(200)
    const expected = Buffer.from(canonical(response))
    const f = projectionFixture({ response })
    try {
      const page = (await f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context)).data
      assert.equal(page.eof, true)
      assert.equal(page.encoding, 'base64')
      assert.equal(page.chunk, expected.toString('base64'))
      assert.equal(page.text, expected.toString('utf8'))
      assert.equal(page.total_bytes, expected.length)
      assert.equal(page.sha256, digest(expected.toString()))
    } finally {
      f.close()
    }
  }
)

test(
  '有效cursor的重读仍复验当前双方ACL和内容discard，不能缓存授权或页面',
  /** 两侧策略分别撤销，恢复策略也不能恢复已丢弃正文。 */ async () => {
    const f = projectionFixture({ response: responseOfSize(20_000) })
    try {
      const first = (await f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, f.context)).data
      const args = { result_id: 'result_fixture', cursor: first.next_cursor! }
      const second = (await f.service.execute('runtime_result_read', args, f.context)).data
      const principal = f.current()
      f.setCaller({ ...principal, device_scope: { mode: 'selected', machine_ids: [] } })
      await assert.rejects(
        /** caller撤权立即拒绝已有cursor重试。 */ () => f.service.execute('runtime_result_read', args, f.context),
        { code: 'forbidden' }
      )
      f.setCaller(principal)
      assert.deepEqual((await f.service.execute('runtime_result_read', args, f.context)).data, second)
      await f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, f.context)
      await assert.rejects(
        /** 签名和期限均有效仍不得交付已清理内容。 */ () => f.service.execute('runtime_result_read', args, f.context),
        { code: 'content_unavailable' }
      )
    } finally {
      f.close()
    }
  }
)
