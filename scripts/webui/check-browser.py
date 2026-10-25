#!/usr/bin/env python3
"""通过 Chromium 检查隔离 UI 展示与交互；不证明管理后端、认证或真实设备链路。"""
import os
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


def main():
    """在显式本机预览地址运行断言，并把截图与运行结果写到 checkout 外。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path not in ('', '/'):
        raise SystemExit('only the explicit loopback UI fixture server is supported')
    output = Path(args.output).resolve()
    repo = Path(__file__).resolve().parents[2]
    if output.is_relative_to(repo):
        raise SystemExit('browser evidence must be outside the checkout')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    base = args.url.rstrip('/')
    checks = []
    errors = []

    def browser_error(error):
        """收集页面运行时异常，不记录管理响应或页面秘密。"""
        errors.append(error)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        context = browser.new_context(viewport={'width': 1280, 'height': 960}, locale='zh-CN')
        page = context.new_page()
        page.on('pageerror', browser_error)
        page.goto(base + '/')
        page.get_by_text('管理读取尚不可用', exact=False).wait_for()
        assert page.locator('.device-card').count() == 0
        assert page.title() == 'Rovloom 管理'
        assert page.evaluate('typeof window.webUiFixture') == 'undefined'
        logo = page.get_by_role('img', name='Rovloom', exact=True)
        logo.wait_for()
        assert logo.evaluate('(el) => el.complete && el.naturalWidth === 2172 && el.naturalHeight === 724')
        assert logo.evaluate('(el) => Math.abs(el.getBoundingClientRect().width / el.getBoundingClientRect().height - 3) < 0.01')
        logo_response = page.request.get(base + '/rovloom-mark-transparent.png')
        assert logo_response.ok
        assert logo_response.headers['content-type'] == 'image/png'
        assert logo_response.body() == (repo / 'docs/assets/brand/rovloom-mark-transparent.png').read_bytes()
        assert page.locator('link[rel="icon"]').get_attribute('href') == './rovloom-mark-transparent.png'
        wordmark = page.request.get(base + '/rovloom-logo.png')
        assert wordmark.ok and wordmark.headers['content-type'] == 'image/png'
        assert wordmark.body() == (repo / 'docs/assets/brand/rovloom-logo.png').read_bytes()
        checks.append('生产入口不可用且无 fixture 数据或身份回退')
        checks.append('侧栏使用官方横版完整字标，favicon 使用独立橙R；两资产原字节可加载')

        page.goto(base + '/fixtures/')
        page.locator('.metric-card').first.wait_for()
        # 完整设备列表只在设备页；概览只给摘要。
        page.goto(base + '/fixtures/#view=devices')
        page.locator('.device-card').first.wait_for()
        assert page.locator('.device-card').count() == 2
        assert page.locator('.device-card img').count() == 0
        assert page.get_by_role('img', name='Rovloom', exact=True).evaluate(
            '(el) => el.complete && el.naturalWidth === 2172 && el.naturalHeight === 724')
        assert '<img src=x' in page.locator('.device-name').first.inner_text()
        page.locator('.device-name').first.focus()
        page.wait_for_timeout(1200)
        assert page.locator('.device-name').first.evaluate('(el) => el === document.activeElement')
        page.screenshot(path=str(output / 'desktop.png'), full_page=True)
        page.locator('.brand').screenshot(path=str(output / 'branding.png'))
        checks.append('双机器隔离展示、XSS 转义及轮询年龄更新保留键盘焦点')

        page.evaluate("window.webUiFixture.mode='stale_children'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('设备观测已过期', exact=True).first.wait_for()
        assert page.get_by_text('快照有效', exact=True).count() == 1
        assert page.locator('.device-card .good').count() == 0
        assert '连接观测已过期' in page.locator('.device-card').first.inner_text()
        assert '认证观测已过期' in page.locator('.device-card').first.inner_text()
        page.evaluate("window.webUiFixture.mode='normal'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.locator('.device-card .good').first.wait_for()
        checks.append('新鲜 status 不续期旧设备/连接/认证观测，列表无绿色在线')

        page.locator('.device-name').first.click()
        page.get_by_role('heading', name='Runtime providers').wait_for()
        assert page.locator('.provider-card').count() == 3
        assert '管理 readiness：不可用' in page.locator('.provider-card').nth(1).inner_text()
        assert '未核实' in page.locator('.provider-card').nth(2).inner_text()
        assert '在线' in page.locator('main .badges').first.inner_text()
        assert '身份已撤销' not in page.locator('main .badges').first.inner_text()
        assert page.get_by_role('button', name='断开当前连接', exact=True).is_disabled()
        assert page.get_by_role('button', name='撤销设备身份', exact=True).is_disabled()
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(output / 'narrow-detail.png'), full_page=True)
        checks.append('详情认证、未提供字段说明、三条独立 provider 行与不可用变更；390px 无横向溢出')

        for mode, text in [('stale_device', '设备观测已过期'), ('stale_connection', '连接观测已过期'),
                           ('stale_auth', '认证观测已过期'), ('stale_provider', '启停观测已过期'),
                           ('stale_children', '连接观测已过期')]:
            page.evaluate('(mode) => { window.webUiFixture.mode=mode }', mode)
            page.get_by_role('button', name='刷新', exact=True).click()
            page.get_by_text(text, exact=False).filter(visible=True).first.wait_for()
            assert page.get_by_text('快照有效', exact=True).count() == 1
            assert page.locator('.provider-card .good').count() == 0
            if mode in ('stale_device', 'stale_connection', 'stale_auth', 'stale_children'):
                assert page.locator('main .badges .good').count() == 0
            if mode in ('stale_provider', 'stale_runtime'):
                assert page.locator('main .badges .good').first.inner_text() == '在线'
        page.screenshot(path=str(output / 'stale-detail.png'), full_page=True)
        checks.append('详情和 provider 分别检查五层观测时间；旧运行观测不显示绿色 ready，不误改新鲜设备连接')

        page.evaluate("window.webUiFixture.mode='near_stale'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('管理 readiness：就绪 (ready)', exact=True).wait_for()
        page.get_by_text('连接观测已过期', exact=False).first.wait_for()
        assert page.get_by_text('快照有效', exact=True).count() == 1
        assert page.locator('.provider-card .good, main .badges .good').count() == 0
        checks.append('子观测按单调经过时间独立跨过十五秒过期边界')

        page.evaluate("window.webUiFixture.mode='pending'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('连接与认证状态未核实（待配对）', exact=True).wait_for()
        assert page.locator('main .badges .good, .provider-card .good').count() == 0
        assert '已认证' not in page.locator('main .badges').first.inner_text()
        page.locator('.brand').click()
        page.locator('.device-card').first.wait_for()
        assert page.locator('.device-card .good').count() == 0
        assert page.get_by_text('连接与认证状态未核实（待配对）', exact=True).count() == 2
        page.locator('.device-name').first.click()
        page.get_by_role('heading', name='Runtime providers').wait_for()
        checks.append('待配对覆盖连接/认证旧记录，列表与详情无绿色在线/ready或已认证徽标')

        page.evaluate("window.webUiFixture.mode='stale_permissions'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('权限提示已过期，等待刷新；它不授予后端权限。', exact=True).wait_for()
        assert page.get_by_text('快照有效', exact=True).count() == 1
        assert page.get_by_text('管理 readiness：就绪 (ready)', exact=True).count() == 1
        checks.append('权限自身观测过期即失效，未到 TTL 也不能被 status 续期')

        for mode, text in [('unverified', '连接未核实'), ('heartbeat', 'heartbeat_timeout'), ('reconnecting', '重新握手中')]:
            page.evaluate('(mode) => { window.webUiFixture.mode=mode }', mode)
            page.get_by_role('button', name='刷新', exact=True).click()
            page.get_by_text(text, exact=False).filter(visible=True).first.wait_for()
            if mode == 'unverified':
                badges = page.locator('main .badges').first.inner_text()
                assert '已认证' not in badges and '在线' not in badges
        checks.append('unverified 不推导在线/认证，心跳超时与可信重连分别显示')

        page.evaluate("window.webUiFixture.mode='partial'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('Provider 读取暂不可用', exact=False).wait_for()
        assert page.locator('.provider-card').count() == 0
        assert page.locator('main .badges').count() == 1
        checks.append('Provider 部分失败保留独立设备观测')

        page.evaluate("window.webUiFixture.mode='wrong_machine'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('管理响应未通过展示边界校验', exact=False).wait_for()
        assert 'fixture-wrong-machine' not in page.locator('main').inner_text()
        checks.append('越机器投影失败关闭且不覆盖当前详情')

        page.goto(base + '/fixtures/')
        page.locator('.device-card').first.wait_for()
        page.evaluate("window.webUiFixture.mode='hold'")
        page.locator('.device-name').first.click()
        page.get_by_text('正在读取管理状态…', exact=True).wait_for()
        page.evaluate("window.webUiFixture.mode='normal'")
        page.locator('.brand').click()
        page.locator('.device-card').first.wait_for()
        page.evaluate('window.webUiFixture.release()')
        page.wait_for_timeout(100)
        assert page.locator('.provider-card').count() == 0
        assert page.evaluate('window.webUiFixture.aborted') >= 1
        page.locator('.device-name').nth(1).click()
        page.get_by_role('heading', name='隔离测试机 B', exact=True).wait_for()
        assert '身份已撤销' in page.locator('main .badges').first.inner_text()
        page.go_back()
        page.locator('.device-card').first.wait_for()
        checks.append('导航取消、迟到响应隔离、另一机器撤销状态及 Back 无写入')

        page.evaluate("window.webUiFixture.mode='hold'")
        before = page.evaluate('window.webUiFixture.reads')
        page.get_by_role('button', name='刷新', exact=True).click()
        assert page.get_by_role('button', name='刷新', exact=True).is_disabled()
        page.evaluate("document.querySelector('.toolbar button').click()")
        assert page.evaluate('window.webUiFixture.reads') == before + 1
        page.get_by_role('button', name='取消读取', exact=True).click()
        page.get_by_text('已取消本次读取', exact=False).wait_for()
        page.evaluate("window.webUiFixture.mode='normal'; window.webUiFixture.release()")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('快照有效', exact=True).wait_for()
        checks.append('重复点击有界、取消后可刷新且旧响应不生效')

        for mode, text in [('stale', '快照已过期'), ('empty', '你的第一台设备'), ('503', '管理读取尚不可用'),
                           ('degraded', '存储降级')]:
            page.evaluate('(mode) => { window.webUiFixture.mode=mode }', mode)
            page.get_by_role('button', name='刷新', exact=True).click()
            page.get_by_text(text, exact=False).filter(visible=True).first.wait_for()
            assert 'fixture-secret-never-render-this' not in page.content()
        checks.append('过期、空态、503与存储降级')

        for mode, text in [('401', '管理会话未登录或已过期'), ('403', '没有此范围的查看权限'), ('expired', '管理会话未登录或已过期')]:
            page.goto(base + '/fixtures/')
            page.locator('.device-card').first.wait_for()
            page.evaluate('(mode) => { window.webUiFixture.mode=mode }', mode)
            page.get_by_role('button', name='刷新', exact=True).click()
            page.get_by_text(text, exact=False).wait_for()
            assert page.locator('.device-card, .provider-card').count() == 0
            assert page.get_by_role('button', name='刷新', exact=True).is_disabled()
            reads = page.evaluate('window.webUiFixture.reads')
            page.wait_for_timeout(5200)
            assert page.evaluate('window.webUiFixture.reads') == reads
        assert page.evaluate('localStorage.length + sessionStorage.length') == 0
        checks.append('401/403/期限过期清空页面停止读取，无浏览器持久存储')

        page.evaluate('window.webUiFixture.dispose()')
        assert page.locator('#rovloom-management').inner_text() == ''
        assert not errors, [str(error) for error in errors]
        checks.append('卸载清理且无浏览器运行时错误')
        context.close()
        browser.close()
    report = {'passed': len(checks), 'checks': checks, 'evidence': 'synthetic UI projection in real Chromium',
              'management_backend_verified': False, 'real_connector_verified': False}
    (output / 'browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
