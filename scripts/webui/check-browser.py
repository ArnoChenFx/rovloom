#!/usr/bin/env python3
"""通过 Chromium 检查隔离 UI 展示与交互；不证明管理后端、认证或真实设备链路。"""
import os
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def local_timestamp(page, value, time_zone):
    """用与页面相同的语言和浏览器时区重新计算期望时间文本，避免断言再次写死 UTC。"""
    return page.evaluate('''/* 同一浏览器上下文内重新格式化，仅用于核对展示时区。 */ ({value, timeZone}) => {
        const formatter = new Intl.DateTimeFormat(document.documentElement.lang || 'en', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZone: timeZone, timeZoneName: 'shortOffset', hourCycle: 'h23'
        });
        return formatter.format(value);
    }''', {'value': value, 'timeZone': time_zone})


# 与 test/webui/browser-fixture.ts 的 old_calls 模式一致：创建于 3,665 秒前，截止晚 30 秒。
OLD_CALL_AGE_MS = 3_665 * 1_000
CALL_DEADLINE_MS = 30_000


def time_checks(page, base, checks):
    """在两个真实浏览器时区验证时间戳随浏览器转换，而相对年龄仍按服务端时点进位。"""
    clocks = []
    for time_zone in ['Asia/Tokyo', 'America/Los_Angeles']:
        context = page.context.browser.new_context(locale='zh-CN', timezone_id=time_zone,
                                                 viewport={'width': 1440, 'height': 1024})
        zone_page = context.new_page()
        zone_page.goto(base + '/fixtures/#view=calls')
        zone_page.locator('.call-card').first.wait_for()
        zone_page.evaluate("window.webUiFixture.mode='old_calls'")
        zone_page.get_by_role('button', name='刷新', exact=True).click()
        expect(zone_page.locator('.call-card')).to_have_count(3)
        # 服务端可信时点来自页面实际交付的投影，不用浏览器墙钟补造观测年龄。
        server_time = zone_page.evaluate('window.webUiFixture.lastServerTime')
        created_at = server_time - OLD_CALL_AGE_MS
        expected = local_timestamp(zone_page, created_at, time_zone)
        expected_deadline = local_timestamp(zone_page, created_at + CALL_DEADLINE_MS, time_zone)
        rendered = zone_page.locator('.call-time strong').all_text_contents()
        assert rendered == [expected] * 3, (time_zone, rendered, expected)
        assert expected_deadline in zone_page.locator('.call-time').first.inner_text()
        # 同一投影在两个时区必须显示不同钟面时间，证明展示确实跟随浏览器。
        assert 'UTC' not in expected, expected
        clocks.append(expected)
        # 用户报告的 3,665 秒必须收敛成 1 小时前，而不是继续按秒累加。
        expect(zone_page.locator('.call-card').get_by_text('1小时前', exact=True)).to_have_count(3, timeout=15000)
        ages = zone_page.locator('.call-time p').all_text_contents()
        assert not any(text.endswith('秒钟前') for text in ages), ages
        # 设备页“Gateway 接收”时间同样带本机时区标识。
        zone_page.goto(base + '/fixtures/#view=devices')
        zone_page.locator('.device-card').first.wait_for()
        received = zone_page.locator('.device-activity p').all_text_contents()
        assert received and all('GMT' in text or 'UTC' in text for text in received), received
        context.close()
    assert clocks[0] != clocks[1], clocks
    # 中文界面下写死的“UTC”标签已移除，时间自己带时区标识。
    page.goto(base + '/fixtures/#view=devices')
    page.locator('.device-card').first.wait_for()
    page.locator('.device-name').first.click()
    page.get_by_role('heading', name='Runtime providers').wait_for()
    assert '（UTC）' not in page.locator('main').inner_text()
    checks.append('时间戳按浏览器时区渲染并自带偏移标识，两个时区的钟面时间不同，标签无写死 UTC')
    checks.append('相对年龄按量级进位：3,665 秒显示为 1 小时前，不再累加成数千秒')


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
        expect(page.locator('.gateway').get_by_text('快照有效', exact=True)).to_have_count(1)
        # 完整设备列表只在设备页；概览只给摘要。
        page.goto(base + '/fixtures/#view=devices')
        page.locator('.device-card').first.wait_for()
        expect(page.locator('.gateway')).to_have_count(0)
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

        # 平台是账本里的历史上报：列表显示真实 os/发行版/架构，未上报的设备明确显示未记录。
        platforms = page.locator('.device-card [data-platform]')
        assert platforms.count() == 2
        first_platform = platforms.first.inner_text()
        assert 'Linux' in first_platform and 'ubuntu 24.04' in first_platform and 'x64' in first_platform
        second_platform = platforms.nth(1).inner_text()
        assert second_platform.strip() == '平台未记录'
        checks.append('设备列表显示 Linux/发行版/x64，未上报平台的设备明确未记录')

        page.evaluate("window.webUiFixture.mode='stale_children'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('设备观测已过期', exact=True).first.wait_for()
        expect(page.locator('.read-indicator')).to_have_attribute('data-state', 'current')
        assert page.locator('.device-card .good').count() == 0
        assert '连接观测已过期' in page.locator('.device-card').first.inner_text()
        assert '认证观测已过期' in page.locator('.device-card').first.inner_text()
        page.evaluate("window.webUiFixture.mode='normal'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.locator('.device-card .good').first.wait_for()
        checks.append('新鲜 status 不续期旧设备/连接/认证观测，列表无绿色在线')

        page.locator('.device-name').first.click()
        # 详情页在同一登记分组里显示平台与上报时间，且不把它当作在线证据。
        detail_platform = page.locator('.detail-registration').inner_text()
        assert '平台（最近一次上报）' in detail_platform
        assert 'Linux · ubuntu 24.04 · x64' in detail_platform
        checks.append('设备详情显示平台与上报时间，且不参与在线判定')
        page.get_by_role('heading', name='Runtime providers').wait_for()
        expect(page.locator('.gateway')).to_have_count(0)
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
            expect(page.locator('.read-indicator')).to_have_attribute('data-state', 'current')
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
        expect(page.locator('.read-indicator')).to_have_attribute('data-state', 'current')
        assert page.locator('.provider-card .good, main .badges .good').count() == 0
        checks.append('子观测按单调经过时间独立跨过十五秒过期边界')

        # 调用记录页：病态累加的相对年龄必须收敛（在独立上下文里单独验证，不打断本页流程）。
        page.evaluate("window.webUiFixture.mode='pending'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_text('连接与认证状态未核实（待配对）', exact=True).wait_for()
        assert page.locator('main .badges .good, .provider-card .good').count() == 0
        assert '已认证' not in page.locator('main .badges').first.inner_text()
        # 概览只给摘要，状态徽标与设备跳转属于设备页。
        page.goto(base + '/fixtures/#view=devices')
        page.locator('.device-card').first.wait_for()
        assert page.locator('.device-card .good').count() == 0
        assert page.get_by_text('连接与认证状态未核实（待配对）', exact=True).count() == 2
        page.locator('.device-name').first.click()
        page.get_by_role('heading', name='Runtime providers').wait_for()
        checks.append('待配对覆盖连接/认证旧记录，列表与详情无绿色在线/ready或已认证徽标')

        # 权限提示文字已移除；权限观测过期时三个设备操作入口必须保持禁用（按钮逻辑仍在 deviceActions 内）。
        page.evaluate("window.webUiFixture.mode='stale_permissions'")
        page.get_by_role('button', name='刷新', exact=True).click()
        page.get_by_role('heading', name='Runtime providers').wait_for()
        expect(page.locator('.read-indicator')).to_have_attribute('data-state', 'current')
        assert page.get_by_text('权限提示已过期', exact=False).count() == 0
        assert page.get_by_text('短期权限提示有效至', exact=False).count() == 0
        assert page.get_by_text('持久登记状态', exact=False).count() == 0
        assert page.get_by_text('设备 ready 尚无独立观测', exact=False).count() == 0
        assert page.get_by_text('仅展示此设备当前获授权', exact=False).count() == 0
        entries = page.locator('section.actions button')
        assert entries.all_text_contents() == ['改名', '断开当前连接', '撤销设备身份']
        assert entries.evaluate_all('''/* 只读页面没有写后端，三个入口必须禁用。 */ nodes => nodes.every(
            /* 读取实际禁用属性，而不是看文案。 */ node => node.disabled)''')
        assert page.get_by_text('管理 readiness：就绪 (ready)', exact=True).count() == 1
        checks.append('权限提示文案已移除；权限自身观测过期即禁用三个操作入口，未到 TTL 也不能被 status 续期')

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

        # 设备名称是可跳转的链接只在设备页；概览摘要不可点。
        page.goto(base + '/fixtures/#view=devices')
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
        page.goto(base + '/fixtures/#view=devices')
        page.locator('.device-card').first.wait_for()
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
        expect(page.locator('.read-indicator')).to_have_attribute('data-state', 'current')
        expect(page.locator('.device-card .good').first).to_be_visible()
        checks.append('重复点击有界、取消后可刷新且旧响应不生效')

        for mode, text in [('stale', '设备观测已过期'), ('empty', '你的第一台设备'), ('503', '管理读取尚不可用'),
                           ('degraded', '当前禁止管理写入')]:
            page.evaluate('(mode) => { window.webUiFixture.mode=mode }', mode)
            page.get_by_role('button', name='刷新', exact=True).click()
            page.get_by_text(text, exact=False).filter(visible=True).first.wait_for()
            if mode == 'stale':
                expect(page.locator('.read-indicator')).to_have_attribute('data-state', 'stale')
                expect(page.locator('.device-card .good')).to_have_count(0)
            assert 'fixture-secret-never-render-this' not in page.content()
        checks.append('过期、空态、503与存储降级')

        for mode, text in [('401', '管理会话未登录或已过期'), ('403', '没有此范围的查看权限'), ('expired', '管理会话未登录或已过期')]:
            page.goto(base + '/fixtures/')
            page.locator('.device-card').first.wait_for()
            page.evaluate('(mode) => { window.webUiFixture.mode=mode }', mode)
            page.get_by_role('button', name='刷新', exact=True).click()
            page.get_by_text(text, exact=False).wait_for()
            assert page.locator('.device-card, .provider-card').count() == 0
            # 认证失败后轮询自行停止，但刷新按钮保持可用：用户可据此重试（cookie 会话恢复后无需整页刷新）。
            assert page.get_by_role('button', name='刷新', exact=True).is_enabled()
            reads = page.evaluate('window.webUiFixture.reads')
            page.wait_for_timeout(5200)
            assert page.evaluate('window.webUiFixture.reads') == reads
        assert page.evaluate('localStorage.length + sessionStorage.length') == 0
        checks.append('401/403/期限过期清空页面并停止轮询，刷新按钮仍可手动重试，无浏览器持久存储')

        # 时区与相对年龄展示：单独开两个明确时区的上下文，不影响上面的会话/轮询断言。
        page.evaluate("window.webUiFixture.mode='normal'")
        page.goto(base + '/fixtures/#view=devices')
        page.locator('.device-card').first.wait_for()
        time_checks(page, base, checks)

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
