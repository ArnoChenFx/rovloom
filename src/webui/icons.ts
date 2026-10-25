/** 固定本地图标；不读取外部 SVG 或将后端文本解释为标记。 */
const paths = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  devices: 'M3 4h18v12H3zM8 21h8M12 16v5',
  pairing:
    'M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3M21 16v3a2 2 0 0 1-2 2h-3M12 8v8M8 12h8',
  connect: 'M9 8 6 12l3 4M15 8l3 4-3 4M13 5l-2 14',
  arrow: 'M5 12h14M14 7l5 5-5 5',
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6',
  attention: 'M12 3 2 21h20zM12 9v4M12 17h.01',
  book: 'M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1zM12 5v15',
  refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  check: 'M5 12l4 4L19 6',
  chevron: 'M9 5l7 7-7 7',
  gateway: 'M4 3h16v7H4zM4 14h16v7H4zM8 6.5h.01M8 17.5h.01M16 6.5h1M16 17.5h1'
} as const

export type IconName = keyof typeof paths

export function uiIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('ui-icon')
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.65',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false'
  })) {
    svg.setAttribute(key, value)
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}
