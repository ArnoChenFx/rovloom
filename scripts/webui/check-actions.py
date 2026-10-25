#!/usr/bin/env python3
"""通过真实 Chromium 与显式临时 Store/会话 handler 验证页面三动作；不接入用户设备。"""
import os
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def control(context, base, **value):
    """只控制显式 loopback fixture，不作为产品 API。"""
    response = context.request.post(base + '/__fixture', data=value, headers={'origin': base})
    assert response.ok
    return response.json()


def metadata(context, base):
    """取得临时设备公开字段和实际 HTTP 调用序列，不读取凭据。"""
    return context.request.get(base + '/__fixture').json()


def writes(context, base):
    """只统计实际设备提交，不把准备/确认/读取算作变更。"""
    return [name for name in metadata(context, base)['calls'] if name in ['devices_rename', 'devices_disconnect', 'devices_revoke']]


def open_page(context, base, index=0):
    """每个场景重新创建临时后端和原有会话，再打开对应设备详情。"""
    data = control(context, base, mode='reset')
    page = context.new_page()
    page.goto(base + '/fixtures/#machine=' + data['devices'][index]['machine_id'])
    page.locator('[data-device-action="device_rename"]:enabled').wait_for()
    return page, data['devices']


def prepare(page, action, name=None):
    """经真实页面入口准备一次操作，准备后不得有设备写入。"""
    page.locator(f'[data-device-action="{action}"]').click()
    if name:
        page.locator('input[name="device-name"]').fill(name)
        page.locator('.operation-form button').click()
    page.locator('dialog[data-phase="awaiting_confirmation"]').wait_for()


def close_dialog(page):
    """正常关闭已完成或取消的对话框。"""
    page.locator('.operation-controls button').last.click()
    expect(page.locator('dialog')).not_to_be_visible()


def main():
    """覆盖两语两主题、窄屏、真实三动作以及错误/取消/导航/回执边界。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    assert parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.path in ['', '/']
    base = args.url.rstrip('/')
    output = Path(args.output).resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parents[2])
    output.mkdir(parents=True, exist_ok=False)
    checks, errors = [], []

    def page_error(error):
        """记录页面运行时错误，不记录网络正文或凭据。"""
        errors.append(str(error))

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        for language in ['zh-CN', 'en']:
            for theme in ['light', 'dark']:
                for width in [1280, 320]:
                    context = browser.new_context(locale=language, color_scheme=theme, viewport={'width': width, 'height': 900})
                    page, devices = open_page(context, base)
                    page.on('pageerror', page_error)
                    entry = page.locator('[data-device-action="device_rename"]').element_handle()
                    entry.focus()
                    page.wait_for_timeout(1200)
                    assert entry.evaluate('''/* 年龄更新保留同一可聚焦、可点击的真实按钮。 */ button =>
                        button.isConnected && button === document.activeElement''')
                    new_name = f'owned_{language.lower().replace("-", "_")}_{theme}_{width}'
                    prepare(page, 'device_rename', new_name)
                    assert writes(context, base) == []
                    prepares = metadata(context, base)['calls'].count('confirmations_create')
                    page.locator('[data-device-action="device_rename"]').evaluate('''/* 重复后台入口事件不能覆盖正在复核的流程。 */
                        button => {button.click(); button.click()}''')
                    assert page.locator('dialog').get_attribute('data-phase') == 'awaiting_confirmation'
                    assert metadata(context, base)['calls'].count('confirmations_create') == prepares
                    assert page.locator('.operation-facts').inner_text().find(new_name) >= 0
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    box = page.locator('dialog').bounding_box()
                    assert box['x'] >= 0 and box['x'] + box['width'] <= width
                    if width == 320:
                        assert page.locator('dialog button:visible').evaluate_all('''/* 窄屏按钮保持触控高度。 */ nodes => nodes.every(
                            /* 从实际命中区域读取尺寸。 */ node => node.getBoundingClientRect().height >= 48)''')
                    page.screenshot(path=str(output / f'{language}-{theme}-{width}-review.png'))
                    page.locator('.operation-confirm').evaluate('''/* 验证快速重复事件不能形成第二次提交。 */ button => {button.click(); button.click()}''')
                    page.locator('dialog[data-phase="committed"]').wait_for()
                    assert writes(context, base) == ['devices_rename']
                    assert metadata(context, base)['devices'][0]['name'] == new_name
                    assert ('原生工作' if language == 'zh-CN' else 'native work') in page.locator('dialog').inner_text()
                    close_dialog(page)
                    expect(page.locator('main h1')).to_have_text(new_name)
                    checks.append(f'{language}/{theme}/{width}: stable entry, duplicate entry/confirm protection, explicit review, one real Store rename, receipt, refresh, responsive layout')
                    context.close()

        context = browser.new_context(locale='en', color_scheme='light')
        for action in ['device_disconnect', 'device_revoke']:
            page, devices = open_page(context, base)
            page.on('pageerror', page_error)
            prepare(page, action)
            assert writes(context, base) == []
            if action == 'device_disconnect':
                assert 'Connection epoch' in page.locator('dialog').inner_text()
            else:
                assert 'fixture-provider' in page.locator('dialog').inner_text()
            page.locator('.operation-confirm').click()
            page.locator('dialog[data-phase="committed"]').wait_for()
            data = metadata(context, base)
            assert data['devices'][0]['status'] == ('offline' if action == 'device_disconnect' else 'revoked')
            assert data['devices'][1]['status'] == 'online'
            assert writes(context, base) == [('devices_disconnect' if action == 'device_disconnect' else 'devices_revoke')]
            checks.append(action + ': real Store effect, exact target, provider/epoch review and native-work warning')
            page.close()

        page, devices = open_page(context, base)
        page.on('pageerror', page_error)
        prepare(page, 'device_rename', 'owned_cancelled')
        page.get_by_role('button', name='Cancel wait', exact=True).click()
        assert writes(context, base) == []
        assert page.locator('dialog').get_attribute('data-phase') == 'cancelled'
        close_dialog(page)
        checks.append('cancel before confirm never writes')
        page.close()

        page, devices = open_page(context, base)
        prepare(page, 'device_revoke')
        page.keyboard.press('Escape')
        expect(page.locator('dialog')).not_to_be_visible()
        assert writes(context, base) == []
        assert page.evaluate('''/* Esc 后焦点回到仍可用入口或稳定主内容。 */ () =>
            document.activeElement === document.querySelector('main') || document.activeElement.matches('[data-device-action]')''')
        checks.append('Escape cancels confirmation and restores keyboard focus without writes')
        page.close()

        page, devices = open_page(context, base)
        page.evaluate('''/* 验证 BFCache 生命周期不会永久卸载本页操作控件。 */ () => {
            window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
            window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
        }''')
        page.locator('[data-device-action="device_rename"]:enabled').wait_for()
        prepare(page, 'device_rename', 'owned_bfcache')
        close_dialog(page)
        assert writes(context, base) == []
        checks.append('BFCache restore recreates reads and keeps usable operation controls without replay')
        page.close()

        page, devices = open_page(context, base)
        control(context, base, mode='stale_device')
        page.get_by_role('button', name='Refresh', exact=True).click()
        expect(page.locator('[data-device-action="device_rename"]')).to_be_disabled()
        assert page.locator('[data-device-action]:enabled').count() == 0
        assert writes(context, base) == []
        checks.append('expired child device observation disables entry despite a fresh global snapshot')
        page.close()

        page, devices = open_page(context, base)
        control(context, base, mode='hold_read')
        page.get_by_role('button', name='Refresh', exact=True).click()
        page.wait_for_timeout(150)
        assert metadata(context, base)['held']
        prepare(page, 'device_rename', 'owned_after_old_read')
        page.locator('.operation-confirm').click()
        page.locator('dialog[data-phase="committed"]').wait_for()
        close_dialog(page)
        expect(page.locator('main h1')).to_have_text('owned_after_old_read')
        control(context, base, mode='release')
        page.wait_for_timeout(250)
        expect(page.locator('main h1')).to_have_text('owned_after_old_read')
        assert writes(context, base) == ['devices_rename']
        checks.append('durable commit replaces old reader; late pre-commit reads cannot overwrite current device state')
        page.close()

        page, devices = open_page(context, base)
        control(context, base, mode='prepare_error')
        page.locator('[data-device-action="device_rename"]').click()
        page.locator('input[name="device-name"]').fill('owned_recovered')
        page.locator('.operation-form button').click()
        page.locator('dialog[data-phase="failed"]').wait_for()
        assert writes(context, base) == []
        control(context, base, mode='normal')
        page.get_by_role('button', name='Prepare again', exact=True).click()
        assert page.locator('input[name="device-name"]').input_value() == 'owned_recovered'
        page.locator('.operation-form button').click()
        page.locator('dialog[data-phase="awaiting_confirmation"]').wait_for()
        close_dialog(page)
        checks.append('prepare error recovery requires explicit new preparation and preserves input')
        page.close()

        for mode in ['hold_confirm', 'hold_reply']:
            page, devices = open_page(context, base)
            prepare(page, 'device_rename', 'owned_' + mode)
            control(context, base, mode=mode)
            page.locator('.operation-confirm').click()
            page.wait_for_timeout(150)
            if mode == 'hold_confirm':
                page.get_by_role('button', name='Cancel wait', exact=True).click()
                control(context, base, mode='release')
                page.wait_for_timeout(250)
                assert writes(context, base) == []
                assert page.locator('dialog').get_attribute('data-phase') == 'cancelled'
            else:
                page.evaluate('''/* 模拟用户切换设备详情，旧请求仍由状态机隔离。 */ id => {location.hash = '#machine=' + id}''', devices[1]['machine_id'])
                expect(page.locator('dialog')).not_to_be_visible()
                page.locator('.operation-resume:visible').wait_for()
                control(context, base, mode='release')
                page.locator('.operation-resume').click()
                page.get_by_role('button', name='Check original receipt', exact=True).click()
                page.locator('dialog[data-phase="committed"]').wait_for()
                assert writes(context, base) == ['devices_rename']
                assert metadata(context, base)['devices'][1]['name'] == 'owned_page_b'
            checks.append(mode + ': cancel/navigation rejects late submission or reconciles only the original receipt')
            page.close()

        page, devices = open_page(context, base)
        prepare(page, 'device_rename', 'owned_lost_reply')
        control(context, base, mode='lost_reply')
        page.locator('.operation-confirm').click()
        page.locator('dialog[data-phase="unconfirmed"]').wait_for()
        assert metadata(context, base)['devices'][0]['name'] == 'owned_lost_reply'
        control(context, base, mode='normal')
        page.get_by_role('button', name='Check original receipt', exact=True).click()
        page.locator('dialog[data-phase="committed"]').wait_for()
        assert writes(context, base) == ['devices_rename']
        checks.append('lost committed reply only checks original durable receipt and never resends')
        page.close()

        page, devices = open_page(context, base)
        page.locator('[data-device-action="device_rename"]').click()
        page.locator('input[name="device-name"]').fill('owned_language_kept')
        page.evaluate("Object.defineProperty(navigator,'languages',{configurable:true,value:['zh-CN']});window.dispatchEvent(new Event('languagechange'))")
        expect(page.locator('input[name="device-name"]')).to_be_focused()
        assert page.locator('input[name="device-name"]').input_value() == 'owned_language_kept'
        assert page.get_by_role('button', name='准备确认', exact=True).count() == 1
        page.emulate_media(color_scheme='dark')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        checks.append('system language/theme changes preserve focused name input without writes')
        page.close()

        page, devices = open_page(context, base)
        prepare(page, 'device_revoke')
        control(context, base, advance=121000)
        expect(page.locator('.operation-confirm')).to_be_disabled(timeout=8000)
        assert writes(context, base) == []
        assert page.get_by_text('Confirmation expired.', exact=False).count() == 1
        checks.append('original server confirmation deadline never extends during read refresh')
        page.close()

        page, devices = open_page(context, base)
        prepare(page, 'device_rename', 'owned_session_lost')
        control(context, base, mode='401')
        page.locator('.operation-confirm').click()
        expect(page.locator('dialog')).not_to_be_visible()
        expect(page.locator('main .device-detail')).to_have_count(0)
        assert page.locator('input[name="device-name"]').input_value() == ''
        assert writes(context, base) == []
        assert page.evaluate('sessionStorage.length') == 0
        checks.append('session loss clears detail and confirmation input; no identity/operation persistence')
        context.close()
        context = browser.new_context(locale='en', color_scheme='light')
        page, _ = open_page(context, base)
        page.on('pageerror', page_error)
        page.locator('.nav-link[href="#view=pairing"]').click()
        expect(page.locator('[name="code-name"]')).to_be_visible()
        page.locator('[name="code-name"]').fill('online-code')
        page.get_by_role('button', name='Generate code', exact=True).click()
        entry = page.locator('.pairing-record:not(.code-created)').filter(has_text='online-code')
        expect(entry).to_be_visible()
        expect(entry).to_contain_text('Unused')
        assert entry.locator('.command-snippet code').inner_text().startswith('rovloom connector --join ws://')
        page.once('dialog', lambda dialog: dialog.accept())
        entry.get_by_role('button', name='Revoke', exact=True).click()
        expect(entry).to_contain_text('Revoked')
        expect(entry.locator('[data-copy]')).to_have_count(0)
        checks.append('pairing: one command creates a code; revocation removes the secret command')
        context.close()

        browser.close()
    assert not errors, errors
    report={'passed':len(checks),'checks':checks,'page_errors':errors,'real_temporary_store_and_handler':True,
            'production_bootstrap_verified':False,'real_user_device_verified':False}
    (output/'actions.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False))


if __name__ == '__main__':
    main()
