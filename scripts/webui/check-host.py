#!/usr/bin/env python3
"""检查连接时主机报告的双语展示、时间来源、旧 DTO 兼容和窄屏布局；仅使用隔离 fixture。"""
import argparse
import json
import os
import runpy
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

preferences = runpy.run_path(str(Path(__file__).with_name('check-preferences.py')))
controls, WORDS = preferences['controls'], preferences['WORDS']


def main():
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
    output.mkdir(parents=True, exist_ok=True)
    errors, checks = [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        for language in ['zh-CN', 'en']:
            for theme in ['light', 'dark']:
                context = browser.new_context(locale=language, color_scheme=theme,
                                              viewport={'width': 1440, 'height': 1024})
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(args.url.rstrip('/') + '/fixtures/#machine=fixture-a')
                page.locator('.detail-registration').wait_for()
                language_control, theme_control = controls(page)
                language_control.choose(language)
                theme_control.choose(theme)
                expect(page.locator('.detail-host')).to_have_count(0)
                page.evaluate("window.webUiFixture.mode='host'")
                page.get_by_role('button', name=WORDS[language]['refresh'], exact=True).click()
                host = page.locator('.detail-host')
                expect(host).to_have_count(1)
                expect(host).to_have_attribute('data-host-source', 'connector_handshake')
                expect(host).to_contain_text('可见逻辑 CPU 数量' if language == 'zh-CN' else 'Visible logical CPUs')
                for value in ['debian-12', 'x86_64', '6.1.0-31-amd64', '16 GiB', 'docker', '0.6.7', '0.9.5', '0.14.3']:
                    expect(host).to_contain_text(value)
                expect(host).to_contain_text('连接器握手' if language == 'zh-CN' else 'Connector handshake')
                expect(page.locator('.detail-connection')).to_contain_text('本次连接建立于' if language == 'zh-CN' else 'Current connection started')
                original = host.inner_text()
                page.get_by_role('button', name=WORDS[language]['refresh'], exact=True).click()
                expect(host).to_have_text(original, use_inner_text=True)
                for width in [1440, 320]:
                    page.set_viewport_size({'width': width, 'height': 1024})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(output / f'{language}-{theme}-{width}.png'), full_page=True)
                page.evaluate("window.webUiFixture.mode='normal'")
                page.get_by_role('button', name=WORDS[language]['refresh'], exact=True).click()
                expect(host).to_have_count(0)
                expect(page.locator('.providers-section')).to_have_count(1)
                checks.append(f'{language}/{theme}: handshake source and versions, unchanged report, legacy DTO and 320px layout')
                context.close()
        browser.close()
    assert not errors, errors
    (output / 'checks.json').write_text(json.dumps({'checks': checks}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
