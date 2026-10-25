#!/usr/bin/env python3
"""验证管理工作台的导航、当前页筛选、复制和配对步骤；仅访问显式本机隔离服务。"""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def fixture_url(value):
    parsed = urlsplit(value)
    assert parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.path in ['', '/']
    return value.rstrip('/')


def navigate(page, section):
    page.locator(f'.sidebar-nav a[href="#view={section}"]').click()
    expect(page.locator('main')).to_have_attribute('data-section', section)
    expect(page.locator(f'.sidebar-nav a[href="#view={section}"]')).to_have_attribute('aria-current', 'page')
    expect(page.locator('main')).to_have_attribute('aria-busy', 'false')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--actions-url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    base, actions = fixture_url(args.url), fixture_url(args.actions_url)
    output = Path(args.output).resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parents[2])
    output.mkdir(parents=True, exist_ok=False)
    checks, errors = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        for language in ['zh-CN', 'en']:
            for theme in ['light', 'dark']:
                context = browser.new_context(locale=language, color_scheme=theme,
                    permissions=['clipboard-read', 'clipboard-write'], viewport={'width': 1440, 'height': 1000})
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(base + '/fixtures/')
                page.locator('.device-card').first.wait_for()
                page.evaluate("window.webUiFixture.mode='showcase'")
                page.locator('.toolbar button').first.click()
                expect(page.locator('.device-card')).to_have_count(4)
                expect(page.locator('.metric-value')).to_have_text(['4', '2', '2'])
                assert page.locator('.brand-logo').get_attribute('src') == './rovloom-logo.png'
                page.screenshot(path=str(output / f'overview-{language}-{theme}.png'), full_page=True)
                navigate(page, 'devices')
                search = page.locator('[name="device-search"]')
                before = page.evaluate('window.webUiFixture.reads')
                search.fill('macbook')
                expect(page.locator('.device-card')).to_have_count(1)
                expect(page.locator('.device-name')).to_have_text('macbook-pro')
                page.wait_for_timeout(1200)
                expect(search).to_be_focused()
                expect(search).to_have_value('macbook')
                search.fill('demo-device-3')
                expect(page.locator('.device-name')).to_have_text('home-server')
                search.fill('development')
                expect(page.locator('.device-card')).to_have_count(2)
                search.fill('')
                page.locator('[data-device-filter="online"]').click()
                expect(page.locator('.device-card')).to_have_count(2)
                page.locator('[data-device-filter="attention"]').click()
                expect(page.locator('.device-card')).to_have_count(2)
                page.locator('[data-device-filter="all"]').click()
                search.fill('no-such-device')
                expect(page.locator('.device-card')).to_have_count(0)
                expect(page.locator('.search-empty')).to_be_visible()
                expect(page.locator('.metric-value')).to_have_text(['4', '2', '2'])
                assert page.evaluate('window.webUiFixture.reads') == before
                search.fill('')
                disclosure = page.locator('.device-record').first
                disclosure.locator('summary').click()
                page.wait_for_timeout(1200)
                expect(disclosure).to_have_attribute('open', '')
                for width in [1440, 768, 390, 320]:
                    page.set_viewport_size({'width': width, 'height': 1000})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(output / f'devices-{language}-{theme}-{width}.png'), full_page=True)
                navigate(page, 'connect')
                snippets = page.locator('.connection-step .command-snippet')
                snippets.first.locator('[data-copy]').click()
                expect(snippets.first.locator('[data-copy]')).to_have_attribute('data-copied', 'true')
                assert page.evaluate('navigator.clipboard.readText()') == 'rovloom token list'
                docker = page.locator('.docker-command').first
                docker.locator('summary').click()
                page.wait_for_timeout(1200)
                expect(docker).to_have_attribute('open', '')
                assert 'docker compose run --rm gateway token list' in docker.inner_text()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                navigate(page, 'devices')
                page.evaluate("window.webUiFixture.mode='stale'")
                page.locator('.toolbar button').first.click()
                expect(page.locator('.metric-value')).to_have_text(['2', '—', '—'])
                assert page.locator('.device-card .good').count() == 0
                page.evaluate("window.webUiFixture.mode='401'")
                page.locator('.toolbar button').first.click()
                expect(page.locator('.state-panel')).to_be_visible()
                expect(page.locator('.device-card')).to_have_count(0)
                expect(page.locator('.metric-card')).to_have_count(0)
                checks.append(f'{language}/{theme}: navigation, scoped filters, focus, disclosures, clipboard, four widths, stale/auth removal')
                context.close()
        # 明文局域网没有 Clipboard API 时，复制仍由真实用户点击走原生回退。
        context = browser.new_context(locale='en', permissions=['clipboard-read', 'clipboard-write'])
        context.add_init_script("Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true})")
        page = context.new_page()
        page.goto(base + '/fixtures/#view=connect')
        button = page.locator('.command-snippet [data-copy]').first
        button.click()
        expect(button).to_have_attribute('data-copied', 'true')
        checks.append('clipboard fallback without the secure-context API')
        context.close()
        context = browser.new_context(locale='zh-CN', permissions=['clipboard-read', 'clipboard-write'],
            viewport={'width': 1440, 'height': 1000})
        context.request.post(actions + '/__fixture', data={'mode': 'reset'}, headers={'origin': actions})
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(actions + '/fixtures/#view=pairing')
        expect(page.locator('[name="code-name"]')).to_be_visible()
        page.screenshot(path=str(output / 'pairing-create-zh.png'), full_page=True)
        page.locator('[name="code-name"]').fill('design-workstation')
        page.get_by_role('button', name='生成配对码', exact=True).click()
        entry = page.locator('.pairing-record:not(.code-created)').filter(has_text='design-workstation')
        expect(entry).to_be_visible()
        command = entry.locator('.command-snippet code').inner_text()
        entry.locator('[data-copy]').click()
        expect(entry.locator('[data-copy]')).to_have_attribute('data-copied', 'true')
        assert page.evaluate('navigator.clipboard.readText()') == command
        assert context.request.get(actions + '/__fixture').json()['calls'].count('pairing_codes_create') == 1
        page.screenshot(path=str(output / 'pairing-waiting-zh.png'), full_page=True)
        page.once('dialog', lambda dialog: dialog.accept())
        entry.get_by_role('button', name='作废', exact=True).click()
        expect(entry).to_contain_text('已作废')
        expect(entry.locator('[data-copy]')).to_have_count(0)
        page.set_viewport_size({'width':320,'height':900})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(output / 'pairing-complete-320.png'), full_page=True)
        checks.append('real temporary Store: code generation, command copy and revocation at desktop and phone widths')
        browser.close()
    assert not errors, errors
    report={'passed':len(checks),'checks':checks,'page_errors':errors,'synthetic_preview_only':True}
    (output/'dashboard.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False))


if __name__ == '__main__':
    main()
