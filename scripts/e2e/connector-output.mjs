// E2E 按完整诊断行累计 ready 次数；计数独立于有界 stderr 尾部，截断和旧行都不产生新 ready。
const READY = 'connector_transport ready provider_ready=true'

export function createConnectorOutput() {
  let stderr = ''
  let partial = ''
  let readyCount = 0
  return {
    write(chunk) {
      const text = String(chunk)
      stderr = (stderr + text).slice(-16384)
      const parts = text.split('\n')
      for (let index = 0; index < parts.length; index++) {
        if (partial !== null) {
          partial += parts[index]
          if (partial.length > READY.length) {
            partial = null
          }
        }
        if (index < parts.length - 1) {
          if (partial === READY) {
            readyCount++
          }
          partial = ''
        }
      }
    },
    get stderr() {
      return stderr
    },
    get readyCount() {
      return readyCount
    }
  }
}
