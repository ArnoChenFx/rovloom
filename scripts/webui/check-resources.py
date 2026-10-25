#!/usr/bin/env python3
"""Exercise Dashboard CRUD against the isolated real Store and token registry."""
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
    base = args.url.rstrip('/')
    assert urlsplit(base).hostname == '127.0.0.1'
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    errors, checks = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        context = browser.new_context(locale='zh-CN', color_scheme='light', viewport={'width':1440,'height':1080}, permissions=['clipboard-read','clipboard-write'])
        data = context.request.post(base + '/__fixture', data={'mode':'reset'}, headers={'origin':base}).json()
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base + '/fixtures/#view=connect')
        expect(page.locator('.token-create-form')).to_be_visible()
        expect(page.locator('.resource-feedback')).to_have_text('')
        for name in ['claude-desktop', 'homelab-codex']:
            page.locator('[name="token-name"]').fill(name)
            page.locator('.token-create-form button').click()
            expect(page.locator(f'[data-token-principal="{name}"]')).to_be_visible()
        token = page.locator('[data-token-principal="claude-desktop"]')
        original = token.locator('input').input_value()
        expect(token.locator('input')).to_have_attribute('type','password')
        token.get_by_role('button', name='显示', exact=True).click()
        expect(token.locator('input')).to_have_attribute('type','text')
        token.locator('[data-copy]').click()
        expect(token.locator('[data-copy]')).to_have_attribute('data-copied','true')
        assert page.evaluate('navigator.clipboard.readText()') == original
        token.get_by_role('button', name='隐藏', exact=True).click()
        page.evaluate('document.activeElement.blur(); window.scrollTo(0,0)')
        page.screenshot(path=str(output / 'tokens-zh.png'), full_page=True)
        page.reload()
        expect(page.locator('.token-card')).to_have_count(2)
        assert token.locator('input').input_value() == original
        expect(token.locator('input')).to_have_attribute('type','password')
        page.wait_for_timeout(1200)
        page.locator('[name="token-name"]').fill('pi-agent')
        page.locator('[name="token-days"]').select_option('90')
        page.wait_for_timeout(1200)
        expect(page.locator('[name="token-name"]')).to_have_value('pi-agent')
        expect(page.locator('[name="token-days"]')).to_have_value('90')
        page.locator('[data-preference="language"] button').click()
        expect(page.locator('html')).to_have_attribute('lang','en')
        expect(page.locator('[name="token-name"]')).to_have_value('pi-agent')
        expect(page.locator('[name="token-days"]')).to_have_value('90')
        page.locator('[data-preference="theme"] button').click()
        expect(page.locator('html')).to_have_attribute('data-theme','dark')
        assert token.locator('input').input_value() == original
        page.locator('[data-preference="theme"] button').click()
        page.locator('[data-preference="language"] button').click()
        expect(page.locator('html')).to_have_attribute('lang','zh-CN')
        assert page.locator('.preference-panel').count() == 0
        checks.append('one-click language/theme switching preserves token form and token values')
        checks.append('create, show/hide, HTTP-compatible copy and persisted tokens after page reload')
        for width in [1440,768,390,320]:
            page.set_viewport_size({'width':width,'height':1000})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if width == 390:
                page.evaluate('document.activeElement.blur(); window.scrollTo(0,0)')
                page.screenshot(path=str(output / 'tokens-mobile-zh.png'), full_page=True)
        page.set_viewport_size({'width':1440,'height':1080})
        page.once('dialog', lambda dialog: dialog.dismiss())
        token.get_by_role('button', name='删除', exact=True).click()
        expect(token).to_be_visible()
        page.once('dialog', lambda dialog: dialog.accept())
        token.get_by_role('button', name='删除', exact=True).click()
        expect(token).to_have_count(0)
        page.reload()
        expect(page.locator('.token-card')).to_have_count(1)
        checks.append('cancelled deletion preserves token; confirmed deletion survives reload')
        page.goto(base + '/fixtures/#view=pairing')
        page.locator('[name="pairing-name"]').fill('homelab-workstation')
        page.locator('.pairing-advanced > summary').click()
        page.locator('[name="pairing-policy"]').fill('fixture_policy')
        page.locator('.pairing-form button[type="submit"]').click()
        page.locator('.pairing-review .pairing-confirm').click()
        expect(page.locator('.pairing-record')).to_have_count(1)
        expect(page.locator('.pairing-entry')).to_have_count(1)
        page.evaluate('document.activeElement.blur(); window.scrollTo(0,0)')
        page.screenshot(path=str(output / 'pairing-records-zh.png'), full_page=True)
        page.reload()
        expect(page.locator('.pairing-record')).to_have_count(1)
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('.pairing-record').get_by_role('button', name='删除', exact=True).click()
        expect(page.locator('.pairing-record')).to_have_count(0)
        page.reload()
        expect(page.locator('.pairing-record')).to_have_count(0)
        checks.append('server-backed pairing records survive reload and can be deleted')
        machine = data['devices'][0]['machine_id']
        page.goto(base + '/fixtures/#machine=' + machine)
        expect(page.locator('.resource-delete-card')).to_be_visible()
        page.evaluate('document.activeElement.blur(); window.scrollTo(0,0)')
        page.screenshot(path=str(output / 'device-delete-zh.png'), full_page=True)
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('.resource-delete-card button').click()
        expect(page.locator('main')).to_have_attribute('data-section','devices')
        expect(page.locator('.device-card').filter(has_text='owned_page_a')).to_have_count(0)
        page.reload()
        expect(page.locator('.device-card').filter(has_text='owned_page_a')).to_have_count(0)
        checks.append('device deletion removes the real Store record and survives page reload')
        page.goto(base + '/fixtures/#view=connect')
        expect(page.locator('.token-card')).to_have_count(1)
        context.request.post(base + '/__fixture', data={'mode':'401'}, headers={'origin':base})
        page.locator('.resource-panel .section-heading button').click()
        expect(page.locator('.token-card')).to_have_count(0)
        expect(page.locator('.token-create-form')).to_have_count(0)
        checks.append('expired authorization clears tokens and forms')
        context.request.post(base + '/__fixture', data={'mode':'normal'}, headers={'origin':base})
        for locale, theme in [('en','dark'), ('zh-CN','dark')]:
            alternate = browser.new_context(locale=locale, color_scheme=theme, viewport={'width':1440,'height':1080})
            other = alternate.new_page()
            other.on('pageerror', lambda error: errors.append(str(error)))
            other.goto(base + '/fixtures/#view=connect')
            expect(other.locator('.token-card')).to_have_count(1)
            expect(other.locator('html')).to_have_attribute('lang', locale)
            if locale == 'en':
                expect(other.locator('.token-create-form button')).to_have_text('Create token')
                other.locator('.token-card').get_by_role('button', name='Show', exact=True).click()
                expect(other.locator('.token-card input')).to_have_attribute('type','text')
                other.locator('.token-card').get_by_role('button', name='Hide', exact=True).click()
            other.evaluate('document.activeElement.blur(); window.scrollTo(0,0)')
            other.screenshot(path=str(output / f'tokens-{locale}-{theme}.png'), full_page=True)
            alternate.close()
        checks.append('English and Chinese token management in dark mode')
        browser.close()
    assert not errors, errors
    report = {'passed':len(checks),'checks':checks,'page_errors':errors,'synthetic_preview_only':True}
    (output / 'resources.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
