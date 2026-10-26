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
    assert page.locator('main h1').evaluate('''el => {
        const size = parseFloat(getComputedStyle(el).fontSize);
        const box = el.getBoundingClientRect();
        return el.textContent.trim().length > 0 && size >= 24 && box.width >= size && box.height >= size;
    }''')
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
                page.locator('.metric-card').first.wait_for()
                language_control, theme_control = controls(page)
                language_control.choose(language)
                theme_control.choose(theme)
                # 概览页检查标题在网关卡之上；列对齐与行高属于设备页。
                heading = bounds(page, '.page-heading')
                gateway = bounds(page, '.gateway')
                assert heading['y'] + heading['height'] <= gateway['y']
                summary = page.locator('.gateway-metadata > summary')
                summary.focus()
                page.keyboard.press('Enter')
                expect(page.locator('.gateway-metadata')).to_have_attribute('open', '')
                page.wait_for_timeout(1200)
                assert summary.evaluate('el => el === document.activeElement')
                reads = page.evaluate('window.webUiFixture.reads')
                language_control.choose('en' if language == 'zh-CN' else 'zh-CN')
                expect(page.locator('.gateway-metadata')).to_have_attribute('open', '')
                expect(language_control.trigger).to_be_focused()
                assert page.evaluate('window.webUiFixture.reads') == reads
                summary.focus()
                page.keyboard.press('Enter')
                expect(page.locator('.gateway-metadata')).not_to_have_attribute('open', '')
                language_control.choose(language)
                snapshot(page, output, f'{language}-{theme}-overview-desktop')
                checks.append(f'{language}/{theme}: overview alone keeps Gateway status and keyboard metadata disclosure')
                page.goto(base + '/fixtures/#view=devices')
                page.locator('.device-card').first.wait_for()
                expect(page.locator('main .gateway')).to_have_count(0)
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
                # 平台徽标在两语下都在列表中出现，且不超出所在列宽。
                assert page.locator('.device-card [data-platform]').count() == 2
                assert page.locator('.device-card [data-platform]').first.evaluate('''el => {
                    /* 徽标不得横向溢出所在列，长文本必须换行。 */
                    const cell = el.closest('.device-health');
                    return el.getBoundingClientRect().width <= cell.getBoundingClientRect().width + 1;
                }''')
                snapshot(page, output, f'{language}-{theme}-list-desktop')
                page.set_viewport_size({'width': 320, 'height': 900})
                # 320px 下平台徽标仍在视口内且不撑破页面宽度。
                assert page.locator('.device-card [data-platform]').first.evaluate('''el => {
                    /* 窄屏断言：徽标完整落在视口内且不产生横向滚动。 */
                    const box = el.getBoundingClientRect();
                    return box.left >= 0 && box.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth;
                }''')
                snapshot(page, output, f'{language}-{theme}-list-320', narrow=True)
                checks.append(f'{language}/{theme}: aligned desktop columns, visible device rows, original wordmark proportions, readable text and 320px list')

                page.set_viewport_size({'width': 1440, 'height': 1024})
                page.goto(base + '/fixtures/#view=calls')
                expect(page.locator('.call-card')).to_have_count(3)
                expect(page.locator('main .gateway')).to_have_count(0)
                expect(page.locator('.call-metrics p, .distribution-heading .muted')).to_have_count(0)
                assert page.locator('.calls-section').evaluate('el => getComputedStyle(el).borderLeftWidth === "0px"')
                # 明细列表整体是一个带边框的容器，表头与每一行都在框内。
                frame = page.locator('.call-table')
                expect(frame).to_have_count(1)
                assert frame.evaluate('''/* 容器必须真有边框、圆角与裁切，与设备列表同一视觉语言。 */ el => {
                    const style = getComputedStyle(el);
                    return style.borderTopWidth === '1px' && style.borderBottomWidth === '1px'
                        && style.borderLeftWidth === '1px' && style.borderRightWidth === '1px'
                        && style.borderTopStyle === 'solid' && parseFloat(style.borderTopLeftRadius) >= 8
                        && style.overflow === 'clip';
                }''')
                assert frame.evaluate('''/* 表头与全部行都在同一个容器内，且表头在行之前。 */ el => {
                    const columns = el.querySelector(':scope > .call-columns');
                    const list = el.querySelector(':scope > .call-list');
                    if (!columns || !list) return false;
                    return list.querySelectorAll('.call-card').length === 3
                        && Boolean(columns.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
                }''')
                assert frame.evaluate('''/* 表头底部有分隔线，最后一行不再画边框，行间用一条分隔线。 */ el => {
                    const columns = getComputedStyle(el.querySelector('.call-columns'));
                    const cards = [...el.querySelectorAll('.call-card')];
                    const borders = cards.map(/* 读取每一行的实际下边框宽度。 */ card => getComputedStyle(card).borderBottomWidth);
                    const boxes = cards.map(/* 读取每一行的实际盒子高度。 */ card => card.getBoundingClientRect().height);
                    return columns.borderBottomWidth === '1px' && borders.slice(0, -1).every(width => width === '1px')
                        && borders.at(-1) === '0px' && boxes.every(height => height > 0);
                }''')
                # 卡片不再各自浮动：同一行内相邻卡片无缝相接，整体只有容器一层阴影。
                assert frame.evaluate('''/* 行与行之间不留空隙，阴影只在容器上。 */ el => {
                    const cards = [...el.querySelectorAll('.call-card')];
                    const shadows = cards.filter(/* 行本身不再投射独立阴影。 */ card => getComputedStyle(card).boxShadow !== 'none');
                    const gaps = cards.slice(1).map(/* 比较相邻行的实际位置。 */ (card, index) =>
                        card.getBoundingClientRect().top - cards[index].getBoundingClientRect().bottom);
                    return shadows.length === 0 && gaps.every(gap => Math.abs(gap) <= 1);
                }''')
                labels = page.locator('.distribution-label').all_text_contents()
                assert any('fixture-a' in label for label in labels)
                assert any('fixture-b' in label for label in labels)
                snapshot(page, output, f'{language}-{theme}-calls-desktop')
                page.locator('[data-call-filter="pending"]').click()
                expect(page.locator('.call-card')).to_have_count(1)
                assert page.locator('.call-metrics .metric-value').first.inner_text() == '3'
                page.locator('[data-call-filter="all"]').click()
                expect(page.locator('.call-card')).to_have_count(3)
                # Explicit presentation fixtures exercise both previous-link forms, including a now-empty page.
                for number, previous in [(2, None), (3, 'fixture-page-2')]:
                    page.goto(base + f'/fixtures/#view=calls&calls=fixture-page-{number}')
                    expect(page.locator('.call-card')).to_have_count(3)
                    page.evaluate("window.webUiFixture.mode='hold'")
                    page.get_by_role('button', name=WORDS[language]['refresh'], exact=True).click()
                    page.wait_for_function('window.webUiFixture.pending.length > 0')
                    page.evaluate('''previous => {
                        const fixture = window.webUiFixture;
                        const calls = fixture.pending.at(-1).snapshot.value.calls;
                        calls.previous_cursor = previous;
                        delete calls.next_cursor;
                        if (previous !== null) calls.items = [];
                        fixture.release();
                    }''', previous)
                    previous_link = page.locator('.call-pagination a[rel="prev"]')
                    expect(previous_link).to_have_count(1)
                    href = previous_link.get_attribute('href')
                    assert ('calls=' not in href) if previous is None else ('calls=fixture-page-2' in href)
                    page.evaluate("window.webUiFixture.mode='normal'")
                    previous_link.click()
                    expect(page.locator('.call-card')).to_have_count(3)
                page.goto(base + '/fixtures/#view=calls')
                expect(page.locator('.call-card')).to_have_count(3)
                page.set_viewport_size({'width': 320, 'height': 900})
                snapshot(page, output, f'{language}-{theme}-calls-320', narrow=True)
                checks.append(f'{language}/{theme}: framed call table with header and rows inside one bordered container, machine-scoped labels, stable filter counts, previous links on full/empty pages and 320px layout')

                page.goto(base + '/fixtures/#view=devices')
                page.locator('.device-card').first.wait_for()
                page.set_viewport_size({'width': 1440, 'height': 1024})
                page.locator('.device-name').first.click()
                page.locator('.provider-card').first.wait_for()
                expect(page.locator('main .gateway')).to_have_count(0)
                connection = bounds(page, '.detail-connection')
                registration = bounds(page, '.detail-registration')
                observations = bounds(page, '.detail-observation')
                assert abs(connection['y'] - registration['y']) <= 1
                assert observations['y'] >= connection['y'] + connection['height']
                assert page.locator('.actions button:enabled').count() == 0
                # 详情把平台放在登记分组里，并在观测分组给出上报时间。
                registration_text = page.locator('.detail-registration').inner_text()
                assert 'x64' in registration_text and 'ubuntu 24.04' in registration_text
                assert page.locator('.detail-registration .facts .fact').count() == 5
                snapshot(page, output, f'{language}-{theme}-detail-desktop')

                page.set_viewport_size({'width': 320, 'height': 900})
                snapshot(page, output, f'{language}-{theme}-detail-320', narrow=True)
                checks.append(f'{language}/{theme}: grouped detail, disabled writes, no repeated Gateway card and 320px detail')
                for section in ['pairing', 'connect']:
                    page.goto(base + '/fixtures/#view=' + section)
                    page.locator('main h1').wait_for()
                    expect(page.locator('main .gateway')).to_have_count(0)
                context.close()

        context = browser.new_context(locale='en', color_scheme='light', viewport={'width': 1280, 'height': 960})
        page = context.new_page()
        page.on('pageerror', page_error)
        page.goto(base + '/')
        page.get_by_text(WORDS['en']['unavailable'], exact=False).wait_for()
        assert page.evaluate('typeof window.webUiFixture') == 'undefined'
        snapshot(page, output, 'production-unavailable')
        # 概览只给摘要；状态徽标、空态与列表都迁到设备页验证。
        for mode, selector in [('empty', '.empty h2'), ('unverified', '.device-card .warning'),
                               ('stale_children', '.device-card .warning'), ('pending', '.device-card .warning'),
                               ('401', '.state-panel')]:
            page.goto(base + '/fixtures/#view=devices')
            # 仅改 hash 不会重载页面，上一轮的 fixture 情景仍会留在内存里，先复位再断言。
            page.evaluate("window.webUiFixture.mode='normal'")
            page.get_by_role('button', name='Refresh', exact=True).click()
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
