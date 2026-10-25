/** 用户点击后复制所选命令、申请编号或管理员已查看的 Token；HTTP 局域网也可使用原生选择复制回退。 */
import { uiIcon } from './icons.js'

export function copyControl(value: string, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'copy-button'
  button.dataset.copy = value
  button.setAttribute('aria-label', label)
  button.title = label
  button.append(uiIcon('copy'))
  return button
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 明文局域网或浏览器权限限制时，沿用这次用户点击的原生复制路径。
  }
  const active = document.activeElement
  const input = document.createElement('textarea')
  input.className = 'copy-buffer'
  input.value = value
  input.readOnly = true
  input.setAttribute('aria-label', 'Copy')
  document.body.append(input)
  try {
    input.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    input.remove()
    if (active instanceof HTMLElement && active.isConnected) {
      active.focus({ preventScroll: true })
    }
  }
}
