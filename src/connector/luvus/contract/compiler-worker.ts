// 私有 Bun Worker 只编译审核安装契约，保留完整根与引用约束，不处理 RPC 原文或授权。
import { compileArtifact } from './compiler-core.js'
import { ARTIFACT_VERSION } from './compiler-protocol.js'
import type { CompileJob } from './compiler-protocol.js'

const channel = globalThis as unknown as {
  onmessage: (event: { data: unknown }) => void
  postMessage(message: unknown): void
}

// 编译器异常可能带完整 schema/生成源码；Worker 不向 MCP stdout/stderr 透传这些内容。
function discardLog(): void {}
console.log = console.warn = console.error = discardLog

// 只接收准确版本及字段；未知消息不能触发兼容推断、代码加载或安装。
channel.onmessage = /* 编译和输出仅限当前私有任务，失败不发送 schema 异常原文。 */ (event) => {
  const job = event.data as CompileJob
  if (!job || typeof job !== 'object' || typeof job.job_id !== 'string' || !/^[a-f0-9-]{36}$/.test(job.job_id)) {
    return
  }
  if (
    Array.isArray(job) ||
    Object.keys(job).length !== 4 ||
    !['version', 'job_id', 'bytes', 'options'].every(
      /* 禁止缺字段或额外字段参与私有编译。 */ (key) => Object.hasOwn(job, key)
    ) ||
    job.version !== ARTIFACT_VERSION
  ) {
    channel.postMessage({
      version: ARTIFACT_VERSION,
      job_id: job.job_id,
      result: {
        ok: false,
        error: {
          origin: 'contract',
          code: 'schema_unavailable',
          stage: 'compile',
          reason: 'compiler_protocol_invalid'
        }
      }
    })
    return
  }
  const result = compileArtifact(job.bytes, job.options)
  channel.postMessage({ version: ARTIFACT_VERSION, job_id: job.job_id, result })
}
