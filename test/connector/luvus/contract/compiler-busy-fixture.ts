// 在隔离测试 Worker 中模拟不可返回的编译任务；不读取文件、凭据或真实端点。
const channel = globalThis as unknown as { onmessage: () => void }
channel.onmessage = /* 无限计算只在自有 Worker 中运行，测试由宿主期限终止它。 */ () => {
  while (true) {
    /* 等待宿主请求终止。 */
  }
}
