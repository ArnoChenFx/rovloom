#!/usr/bin/env python3
"""真实非安全 HTTP origin 下验证管理操作；请求转交现有隔离 fixture，生产 LAN 认证另由集成测试覆盖。"""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    assert parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.path in ['', '/']
    base = args.url.rstrip('/')
    origin = 'http://192.0.2.10:' + str(parsed.port)
    output = Path(args.output).resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parents[2])
    output.mkdir(parents=True, exist_ok=False)
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        context = browser.new_context(locale='en')
        reset = context.request.post(base + '/__fixture', data={'mode': 'reset'}, headers={'origin': base})
        assert reset.ok
        device = reset.json()['devices'][0]['machine_id']

        def forward(route):
            # 仅改隔离 fixture 的传输地址；浏览器保留 LAN origin 与真实 Web Crypto 能力。
            request = route.request
            assert request.url.startswith(origin + '/')
            headers = dict(request.headers)
            headers['host'] = parsed.netloc
            if 'origin' in headers:
                assert headers['origin'] == origin
                headers['origin'] = base
            response = route.fetch(url=base + request.url[len(origin):], headers=headers)
            route.fulfill(response=response)

        context.route(origin + '/**', forward)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(origin + '/fixtures/#machine=' + device)
        assert page.evaluate('!isSecureContext && typeof crypto.randomUUID === "undefined"')
        page.locator('[data-device-action="device_rename"]:enabled').wait_for()
        page.locator('[data-device-action="device_rename"]').click()
        page.locator('input[name="device-name"]').fill('owned_lan_renamed')
        page.locator('.operation-form button').click()
        page.locator('dialog.operation-dialog[data-phase="awaiting_confirmation"]').wait_for()
        page.locator('.operation-confirm').click()
        page.locator('dialog.operation-dialog[data-phase="committed"]').wait_for()
        page.locator('.operation-controls button').last.click()
        page.locator('.nav-link[href="#view=pairing"]').click()
        expect(page.locator('[name="code-name"]')).to_be_visible()
        page.locator('[name="code-name"]').fill('owned-lan-pairing')
        page.get_by_role('button', name='Generate code', exact=True).click()
        entry = page.locator('.pairing-record:not(.code-created)').filter(has_text='owned-lan-pairing')
        expect(entry).to_be_visible()
        assert entry.locator('.command-snippet code').inner_text().startswith('rovloom connector --join ws://192.0.2.10:9443#')
        calls = context.request.get(base + '/__fixture').json()['calls']
        assert calls.count('devices_rename') == 1
        assert calls.count('pairing_codes_create') == 1
        assert not errors, errors
        (output / 'lan.json').write_text(json.dumps({'passed': True, 'secure_context': False, 'randomUUID': False,
            'device_rename_committed': True, 'pairing_create_committed': True, 'page_errors': errors}, indent=2) + '\n')
        browser.close()
    print('LAN browser device rename and pairing committed without randomUUID')


if __name__ == '__main__':
    main()
