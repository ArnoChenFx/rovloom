/**
 * 页面内二次确认对话框：原生 window.confirm 会阻塞脚本、按钮语言随浏览器、
 * 样式不可控也无法被验收脚本显式断言，因此统一用模态 <dialog>。
 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.textContent = text
  element.className = className
  return element
}

export type ConfirmRequest = Readonly<{
  title: string
  message: string
  accept: string
  cancel: string
}>

/**
 * 每次 ask() 打开一次模态确认：接受返回 true，取消、Escape 与任何其它关闭路径都返回 false，
 * 绝不留下来永不结算的 Promise。关闭后焦点回到触发元素。
 */
export function createConfirmDialog() {
  // 独立类名，不复用设备操作对话框的 data-phase 状态机：两者共存时选择器不会互相误伤。
  const element = node('dialog', '', 'confirm-dialog')
  element.dataset.confirmDialog = ''
  const heading = node('h2', '', 'confirm-heading')
  heading.id = 'panel-confirm-heading'
  const message = node('p', '', 'confirm-message')
  message.id = 'panel-confirm-message'
  element.setAttribute('aria-labelledby', heading.id)
  element.setAttribute('aria-describedby', message.id)
  const controls = node('div', '', 'confirm-controls')
  const accept = node('button', '', 'confirm-accept')
  accept.type = 'button'
  accept.dataset.confirmAccept = ''
  const cancel = node('button')
  cancel.type = 'button'
  cancel.dataset.confirmCancel = ''
  controls.append(accept, cancel)
  element.append(heading, message, controls)
  let settle: ((value: boolean) => void) | undefined
  let returnFocus: HTMLElement | undefined

  /** 唯一结算路径：先清空待结算状态再关闭，close 事件因此不会重复结算。 */
  function finish(value: boolean) {
    const resolve = settle
    settle = undefined
    if (element.open) {
      element.close()
    }
    resolve?.(value)
    // 焦点回到触发按钮，键盘用户不必重新找位置。
    returnFocus?.focus()
    returnFocus = undefined
  }

  accept.addEventListener('click', () => finish(true))
  cancel.addEventListener('click', () => finish(false))
  element.addEventListener('cancel', (event) => {
    // Escape 等同取消：屏蔽浏览器默认关闭，统一走同一条结算路径。
    event.preventDefault()
    finish(false)
  })
  element.addEventListener('close', () => {
    // 任何其它关闭路径也必须给出结果，不能让调用方一直等下去。
    if (settle) {
      finish(false)
    }
  })

  return {
    element,
    /** 打开一次确认；上一次未结算时先按取消结算，两次提交不会并发。 */
    ask(request: ConfirmRequest): Promise<boolean> {
      finish(false)
      return new Promise<boolean>((resolve) => {
        settle = resolve
        heading.textContent = request.title
        message.textContent = request.message
        accept.textContent = request.accept
        cancel.textContent = request.cancel
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
        element.showModal()
        accept.focus()
      })
    },
    /** 页面切换或授权失效时按取消结算，避免留下悬挂的确认。 */
    dismiss() {
      if (settle || element.open) {
        finish(false)
      }
    }
  }
}
