#!/usr/bin/env python3
"""通过真实 Chromium 验证生产 browser.js 消费 CLI meta；仅连接显式临时 Store/会话 fixture。"""
import os
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect


def main():
    """检查真实 DOM 一次消费、错误交付、在页过期、三动作入口及页面生命周期。"""
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
    marker = 'meta[name="rovloom-management-bootstrap"]'

    def page_error(error):
        """只记录页面异常分类，不输出 token 或 HTTP 正文。"""
        errors.append(str(error))

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        for variant in ['valid', 'missing', 'duplicate', 'bad_token', 'bad_expiry', 'expired', 'live_expiry', 'no_root', 'permanent_exit']:
            context = browser.new_context(locale='en', viewport={'width': 1280, 'height': 900})
            reset = context.request.post(base + '/__fixture', data={'mode': 'reset'}, headers={'origin': base})
            assert reset.ok
            device = reset.json()['devices'][0]['machine_id']

            delivered = {'expires_at': 0}

            def deliver(route):
                """在显式测试 HTML 上模拟既定 meta 的缺失/无效情形，不定义新产品入口。"""
                response = route.fetch()
                assert response.headers['cache-control'] == 'no-store'
                body = response.text()
                tag = re.search(r'<meta name="rovloom-management-bootstrap"[^>]*>', body).group()
                delivered['expires_at'] = int(re.search(r'data-expires-at="([0-9]+)"', tag).group(1))
                replacement = tag
                if variant == 'missing':
                    replacement = ''
                elif variant == 'duplicate':
                    replacement = tag + tag
                elif variant == 'bad_token':
                    replacement = re.sub(r'content="[^"]*"', 'content="invalid"', tag)
                elif variant == 'bad_expiry':
                    replacement = re.sub(r'data-expires-at="[^"]*"', 'data-expires-at="NaN"', tag)
                elif variant == 'expired':
                    replacement = re.sub(r'data-expires-at="[^"]*"', 'data-expires-at="0"', tag)
                body = body.replace(tag, replacement)
                if variant == 'no_root':
                    body = body.replace('id="rovloom-management"', 'id="fixture-without-root"')
                assert './browser.js' in body and './fixture.js' not in body
                route.fulfill(response=response, body=body)

            context.route('**/fixtures/', deliver)
            page = context.new_page()
            page.on('pageerror', page_error)
            page.goto(base + '/fixtures/#machine=' + device)
            expect(page.locator(marker)).to_have_count(0)
            assert 'd' * 43 not in page.locator('html').inner_html()
            assert page.evaluate('sessionStorage.length') == 0
            assert page.evaluate('document.cookie') == ''
            assert page.evaluate('''/* 仅展示偏好可持久化，bootstrap 不写浏览器存储。 */ () =>
                Object.keys(localStorage).every(key => ['rovloom.webui.language', 'rovloom.webui.theme'].includes(key))''')
            if variant == 'no_root':
                assert page.locator('#rovloom-management').count() == 0
                assert context.request.get(base + '/__fixture').json()['calls'] == []
            else:
                entry = page.locator('[data-device-action="device_rename"]:enabled')
                entry.wait_for()
                if variant == 'permanent_exit':
                    page.evaluate('''/* 永久离开释放本入口拥有的页面和客户端。 */ () => {
                        window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
                        window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}));
                    }''')
                    assert page.locator('#rovloom-management').inner_html() == ''
                else:
                    if variant == 'live_expiry':
                        page.evaluate('''/* 使用实际交付截止推进浏览器墙钟，不假定fixture租期。 */ deadline => {
                            Date.now = () => deadline + 1;
                        }''', delivered['expires_at'])
                    entry.click()
                    page.locator('input[name="device-name"]').fill('owned_production_entry')
                    page.locator('.operation-form button').click()
                    if variant == 'valid':
                        page.locator('dialog.operation-dialog[data-phase="awaiting_confirmation"]').wait_for()
                        page.screenshot(path=str(output / 'production-entry-review.png'))
                        page.locator('.operation-confirm').click()
                        page.locator('dialog.operation-dialog[data-phase="committed"]').wait_for()
                    else:
                        expect(page.locator('dialog.operation-dialog')).not_to_be_visible()
                        expect(page.locator('main .device-detail')).to_have_count(0)
            data = context.request.get(base + '/__fixture').json()
            writes = [call for call in data['calls'] if call in ['devices_rename', 'devices_disconnect', 'devices_revoke']]
            assert writes == (['devices_rename'] if variant == 'valid' else [])
            if variant not in ['valid', 'permanent_exit', 'no_root']:
                assert 'history_open' not in data['calls']
            checks.append(variant + ': production browser entry consumes/removes DOM delivery and fails closed or commits exactly once')
            context.close()
        browser.close()
    assert not errors, errors
    report = {'passed': len(checks), 'checks': checks, 'page_errors': errors,
              'production_browser_entry_verified': True, 'real_temporary_store_and_handler': True,
              'real_administrator_or_user_device_verified': False}
    (output / 'bootstrap.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
