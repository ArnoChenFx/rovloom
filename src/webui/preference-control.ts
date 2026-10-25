/** 创建仅影响展示偏好的图标选择器；固定 SVG 不加载外部资源，也不接触管理身份或读取状态。 */
import type { Localizer } from './i18n.js'

const paths = {
  language: 'M2 5h12M7 2h1M12 5c-1 6-4 9-8 11M5 8c2 4 4 6 7 8M13 22l5-11 5 11M15 18h6',
  light:
    'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5',
  dark: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z'
}

/** 生成固定线条图标，辅助技术只读取按钮名称与当前选择。 */
function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

/** Native buttons toggle the resolved preference in one click, including Enter/Space. */
export function createPreferenceControl(kind: 'language' | 'theme', onChoose: (value: string) => void) {
  const root = document.createElement('div')
  root.className = 'preference'
  root.dataset.preference = kind
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'preference-trigger'
  const current = document.createElement('span')
  current.className = 'visually-hidden'
  current.id = `rovloom-${kind}-current`
  trigger.setAttribute('aria-describedby', current.id)
  root.append(trigger, current)
  let next = ''
  function click(): void {
    if (next) {
      onChoose(next)
    }
  }
  function update(i18n: Localizer, value: string): void {
    const language = kind === 'language'
    const label = i18n.t(language ? 'language.label' : 'theme.label')
    next = language ? (value === 'zh-CN' ? 'en' : 'zh-CN') : value === 'dark' ? 'light' : 'dark'
    const name = i18n.t(
      language
        ? value === 'zh-CN'
          ? 'language.chinese'
          : 'language.english'
        : value === 'dark'
          ? 'theme.dark'
          : 'theme.light'
    )
    const target = i18n.t(
      language
        ? next === 'zh-CN'
          ? 'language.chinese'
          : 'language.english'
        : next === 'dark'
          ? 'theme.dark'
          : 'theme.light'
    )
    current.textContent = `${name}. ${i18n.t('preference.switch', { value: target })}`
    trigger.setAttribute('aria-label', label)
    trigger.title = `${label}: ${current.textContent}`
    trigger.dataset.value = value
    trigger.dataset.nextValue = next
    trigger.replaceChildren(icon(language ? 'language' : value === 'dark' ? 'dark' : 'light'))
  }
  trigger.addEventListener('click', click)
  return {
    root,
    update,
    dispose(): void {
      next = ''
      trigger.removeEventListener('click', click)
    }
  }
}
