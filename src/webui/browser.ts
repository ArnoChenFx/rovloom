/** 内置页面消费宿主既有 CSRF meta 并接入同源读写；不导入 fixture 或自报身份。 */
import { mountWebUi } from './page.js'
import { createManagementPageRead } from './read.js'
import { createManagementHttpRead } from './http-client.js'
import { createManagementWriteClient } from './write-client.js'
import { createResourceClient } from './resource-client.js'
import { createManagementPageCsrf } from './bootstrap.js'

const csrf = createManagementPageCsrf(document)
const root = document.getElementById('rovloom-management')
if (root) {
  const client = createManagementWriteClient({ csrf })
  const unmount = mountWebUi(
    root,
    createManagementPageRead(createManagementHttpRead()),
    undefined,
    client,
    createResourceClient(csrf)
  )
  /** BFCache 保留原内存截止；永久离开时卸载页面并关闭本入口拥有的客户端。 */
  function closePage(event: PageTransitionEvent): void {
    if (!event.persisted) {
      unmount()
      client.close()
      window.removeEventListener('pagehide', closePage)
    }
  }
  window.addEventListener('pagehide', closePage)
}
