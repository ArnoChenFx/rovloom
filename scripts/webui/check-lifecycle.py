#!/usr/bin/env python3
"""通过生产browser.js和临时Store/HTTP会话fixture验收provider禁用页面；不控制用户设备。"""
import os
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def control(context, base, **value):
    """只操作显式loopback测试服务的自有内存fixture。"""
    reply = context.request.post(base + '/__fixture', data=value, headers={'origin': base})
    assert reply.ok
    return reply.json()


def metadata(context, base):
    """只读取公开状态及动作名称，不输出任何凭据。"""
    return context.request.get(base + '/__fixture').json()


def confirm(page):
    """快速重复点击仍只提交原确认一次。"""
    page.locator('dialog.operation-dialog[data-phase="awaiting_confirmation"]').wait_for()
    page.locator('.operation-confirm').evaluate('''/* 重复人工事件不能形成第二次提交。 */ button => {button.click(); button.click()}''')
    page.locator('dialog.operation-dialog[data-phase="committed"]').wait_for()


def close(page):
    """关闭原状态机对话框并保留页面进度面板。"""
    page.locator('.operation-controls button').last.click()
    expect(page.locator('dialog.operation-dialog')).not_to_be_visible()


def main():
    """覆盖两语两主题、桌面/窄屏、精确确认与持久回执。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    url = urlsplit(args.url)
    assert url.scheme == 'http' and url.hostname == '127.0.0.1'
    base = args.url.rstrip('/')
    output = Path(args.output).resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parents[2])
    output.mkdir(parents=True, exist_ok=False)
    checks, errors = [], []

    def page_error(error):
        """只收集浏览器运行时错误，不记录认证材料。"""
        errors.append(str(error))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        for language in ['en', 'zh-CN']:
            for theme in ['light', 'dark']:
                for width in [1280, 320]:
                    context = browser.new_context(locale=language, color_scheme=theme, viewport={'width': width, 'height': 900})
                    data = control(context, base, mode='reset')
                    page = context.new_page()
                    page.on('pageerror', page_error)
                    machine = data['devices'][0]['machine_id']
                    page.goto(base + '/fixtures/#machine=' + machine)
                    page.locator('[data-provider-action="disable"]:enabled').wait_for()
                    page.locator('[data-provider-action="disable"]').click()
                    page.locator('dialog.operation-dialog[data-phase="awaiting_confirmation"]').wait_for()
                    assert 'fixture-provider' in page.locator('.operation-facts').inner_text()
                    page.screenshot(path=str(output / f'{language}-{theme}-{width}-provider.png'))
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    confirm(page)
                    facts = metadata(context, base)
                    assert facts['calls'].count('providers_disable') == 1
                    assert facts['providers'][0]['binding_revision'] == 2 and not facts['providers'][0]['enabled']
                    assert facts['providers'][1]['enabled']
                    close(page)
                    expect(page.locator('[data-provider-action="disable"]')).to_be_disabled()
                    assert page.locator('.provider-card button').count() == 1
                    checks.append(f'{language}/{theme}/{width}: exact provider confirmation, one commit, independent instance, no re-enable control')
                    context.close()

        browser.close()
    assert not errors, errors
    report = {'passed': len(checks), 'checks': checks, 'page_errors': errors, 'production_browser_bundle': True, 'temporary_store_http_session_fixture': True, 'real_user_devices': False}
    (output / 'lifecycle.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
