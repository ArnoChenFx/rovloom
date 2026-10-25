#!/usr/bin/env python3
"""在真实 Chromium 验证控制台的可读布局与原生折叠交互；截图仅使用显式隔离 fixture。"""
import os
import argparse
import json
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

# 复用现有浏览器断言与稳定控件定位；run_path 不执行其 main 入口。
preferences = runpy.run_path(str(Path(__file__).with_name('check-preferences.py')))
contrast_check, controls, WORDS = (preferences[name] for name in ['contrast_check', 'controls', 'WORDS'])


def bounds(page, selector):
    """在一个同步 DOM 采样中查询边界，避免每秒重绘使跨进程元素句柄过期。"""
    return page.evaluate('''/* 在同一调用中查询与测量当前节点。 */ selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return {x: box.x, y: box.y, width: box.width, height: box.height};
    }''', selector)


def visible_layout(page, narrow=False):
    """检查真实排版边界、正文尺寸及窄屏触控尺寸，不依赖截图像素相等。"""
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert page.locator('main h1').count() == 1
    assert bounds(page, 'main h1')['width'] > 100
    assert bounds(page, '.topbar')['y'] < bounds(page, '.commandbar')['y']
    assert bounds(page, '.commandbar')['y'] < bounds(page, 'main')['y']
    assert page.locator('.brand-logo').evaluate(
        '/* 完整字标保持品牌原图的3:1比例。 */ el => el.naturalWidth / el.naturalHeight === 3 && Math.abs(el.getBoundingClientRect().width / el.getBoundingClientRect().height - 3) < 0.01')
    assert page.locator('main').evaluate(
        '/* 正文必须有适度最大宽度和内边距。 */ el => el.clientWidth <= 1280 && parseFloat(getComputedStyle(el).paddingLeft) >= 16')
    assert page.locator('main').evaluate('''/* 检查实际可见技术文字没有缩成装饰小字。 */ el =>
        [...el.querySelectorAll('dt, dd, .badge, .device-name, code')].every(
            /* 忽略原生折叠区隐藏文字。 */ node => !node.getClientRects().length || parseFloat(getComputedStyle(node).fontSize) >= 12)''')
    if narrow:
        assert page.locator('.preference-trigger:visible, .toolbar button:visible').evaluate_all('''/* 窄屏常用控件保留48px命中高度。 */
            nodes => nodes.every(/* 逐个读取实际命中高度。 */ node => node.getBoundingClientRect().height >= 48)''')
    contrast_check(page)


def snapshot(page, output, name, narrow=False):
    """通过布局断言后记录完整实际页面，不裁去错误提示或测试数据标识。"""
    visible_layout(page, narrow)
    page.screenshot(path=str(output / (name + '.png')), full_page=True)


def main():
    """覆盖两语两主题、桌面与320px，并验证折叠区跨年龄及本地化重绘。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path not in ('', '/'):
        raise SystemExit('only the explicit loopback UI fixture server is supported')
    output = Path(args.output).resolve()
    if output.is_relative_to(Path(__file__).resolve().parents[2]):
        raise SystemExit('browser evidence must be outside the checkout')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    base = args.url.rstrip('/')
    checks = []
    errors = []

    def page_error(error):
        """记录隔离页面的运行时异常，不读取真实管理凭据。"""
        errors.append(str(error))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        for language in ['zh-CN', 'en']:
            for theme in ['light', 'dark']:
                context = browser.new_context(locale=language, color_scheme=theme,
                                              viewport={'width': 1440, 'height': 1024})
                page = context.new_page()
                page.on('pageerror', page_error)
                page.goto(base + '/fixtures/')
                page.locator('.device-card').first.wait_for()
                language_control, theme_control = controls(page)
                language_control.choose(language)
                theme_control.choose(theme)
                heading = bounds(page, '.page-heading')
                gateway = bounds(page, '.gateway')
                assert heading['y'] + heading['height'] <= gateway['y']
                columns = page.evaluate('''/* 同步采样两行坐标，避免年龄重绘使跨调用节点失效。 */ () => {
                    /** 提取同一帧内所有列的横坐标。 */
                    function positions(selector) { return [...document.querySelectorAll(selector)].map(
                        /* 从仍连接的列节点读取坐标。 */ node => node.getBoundingClientRect().x) }
                    return {headers: positions('.device-columns > span'), cells: positions('.device-card:first-child > div')}
                }''')
                assert len(columns['headers']) == len(columns['cells']) == 4
                for index in range(4):
                    assert abs(columns['headers'][index] - columns['cells'][index]) <= 1
                last_row = bounds(page, '.device-card:last-child')
                assert last_row['y'] + last_row['height'] < 1024
                snapshot(page, output, f'{language}-{theme}-list-desktop')
                page.set_viewport_size({'width': 320, 'height': 900})
                snapshot(page, output, f'{language}-{theme}-list-320', narrow=True)
                checks.append(f'{language}/{theme}: aligned desktop columns, visible device rows, original wordmark proportions, readable text and 320px list')

                page.set_viewport_size({'width': 1440, 'height': 1024})
                page.locator('.device-name').first.click()
                page.locator('.provider-card').first.wait_for()
                connection = bounds(page, '.detail-connection')
                registration = bounds(page, '.detail-registration')
                observations = bounds(page, '.detail-observation')
                assert abs(connection['y'] - registration['y']) <= 1
                assert observations['y'] >= connection['y'] + connection['height']
                assert page.locator('.actions button:enabled').count() == 0
                snapshot(page, output, f'{language}-{theme}-detail-desktop')

                summary = page.locator('.gateway-metadata > summary')
                summary.focus()
                page.keyboard.press('Enter')
                expect(page.locator('.gateway-metadata')).to_have_attribute('open', '')
                page.wait_for_timeout(1200)
                assert summary.evaluate('/* 年龄重绘不能夺走原生折叠控件焦点。 */ el => el === document.activeElement')
                expect(page.locator('.gateway-metadata')).to_have_attribute('open', '')
                reads = page.evaluate('window.webUiFixture.reads')
                language_control.choose('en' if language == 'zh-CN' else 'zh-CN')
                expect(page.locator('.gateway-metadata')).to_have_attribute('open', '')
                expect(language_control.trigger).to_be_focused()
                assert page.evaluate('window.webUiFixture.reads') == reads
                summary.focus()
                page.keyboard.press('Enter')
                expect(page.locator('.gateway-metadata')).not_to_have_attribute('open', '')
                language_control.choose(language)
                page.set_viewport_size({'width': 320, 'height': 900})
                snapshot(page, output, f'{language}-{theme}-detail-320', narrow=True)
                checks.append(f'{language}/{theme}: grouped detail, disabled writes, keyboard disclosure survives age/localization without reads and 320px detail')
                context.close()

        context = browser.new_context(locale='en', color_scheme='light', viewport={'width': 1280, 'height': 960})
        page = context.new_page()
        page.on('pageerror', page_error)
        page.goto(base + '/')
        page.get_by_text(WORDS['en']['unavailable'], exact=False).wait_for()
        assert page.evaluate('typeof window.webUiFixture') == 'undefined'
        snapshot(page, output, 'production-unavailable')
        for mode, selector in [('empty', '.empty h2'), ('unverified', '.device-card .warning'),
                               ('stale_children', '.device-card .warning'), ('pending', '.device-card .warning'),
                               ('401', '.state-panel')]:
            page.goto(base + '/fixtures/')
            page.locator('.device-card').first.wait_for()
            page.evaluate('/* 切换明确标注的合成展示情景。 */ mode => { window.webUiFixture.mode = mode }', mode)
            page.get_by_role('button', name='Refresh', exact=True).click()
            page.locator(selector).first.wait_for()
            if mode in ['unverified', 'stale_children', 'pending']:
                assert page.locator('.device-card .good').count() == 0
            if mode in ['empty', '401']:
                assert page.locator('.device-card, .provider-card').count() == 0
            snapshot(page, output, f'state-{mode}')
        checks.append('production unavailable and fixture empty, unknown, stale and session-error states remain honest and readable')
        context.close()
        browser.close()
    assert not errors, errors
    result = {'passed': len(checks), 'checks': checks, 'page_errors': errors,
              'evidence': 'synthetic UI projection in real Chromium',
              'management_backend_verified': False, 'real_connector_verified': False}
    (output / 'layout.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
