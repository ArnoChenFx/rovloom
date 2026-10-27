#!/usr/bin/env python3
"""真实生产页面跨确认截止仍保留原操作；仅使用显式临时 Store/handler，不接用户设备。"""
import os
import argparse
import json
from pathlib import Path
import runpy
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

helpers = runpy.run_path(str(Path(__file__).with_name('check-actions.py')))
control, metadata, open_page, prepare, writes = (helpers[name] for name in ['control', 'metadata', 'open_page', 'prepare', 'writes'])


def scope(value):
    """只比较公开的三元操作关联，不读取任何身份或凭据。"""
    return {key: value[key] for key in ['request_id', 'history_epoch', 'recovery_generation']}


def retained(page, retry, phase):
    """验证按钮不可用，并模拟迟到旧按钮事件确认 handler 独立复验阶段。"""
    assert retry.is_hidden()
    assert retry.is_disabled()
    retry.evaluate('''/* 旧 DOM 事件不能用展示属性覆盖当前操作阶段。 */ button => {
        button.hidden = false; button.disabled = false; button.click();
    }''')
    expect(page.locator('dialog.operation-dialog')).to_have_attribute('data-phase', phase)
    expect(page.locator('.operation-form')).not_to_be_visible()
    retry.evaluate('''/* 恢复测试修改的展示属性，保持后续用户控件真实布局。 */ button => {
        button.hidden = true; button.disabled = true;
    }''')


def main():
    """截止前真实提交、跨截止延迟交付；直接收回执或取消后仅查询原回执。"""
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
        """仅记录页面运行时异常，不输出管理正文或凭据。"""
        errors.append(str(error))

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        for language, theme, width in [('en', 'light', 1280), ('zh-CN', 'dark', 320)]:
            for reconcile in [False, True]:
                context = browser.new_context(locale=language, color_scheme=theme, viewport={'width': width, 'height': 900})
                page, devices = open_page(context, base)
                page.on('pageerror', page_error)
                name = 'owned_deadline_' + ('lookup' if reconcile else 'reply')
                prepare(page, 'device_rename', name)
                control(context, base, mode='hold_reply')
                page.locator('.operation-confirm').click()
                page.wait_for_function('''/* 等真实后端持久提交，仅暂缓 HTTP 回执。 */ async () => {
                    const response = await fetch('/__fixture'); const data = await response.json();
                    return data.held && data.receipts.length === 1;
                }''')
                committed = metadata(context, base)
                original = scope(committed['requests'][0])
                receipt = committed['receipts'][0]
                assert scope(receipt) == original
                assert receipt['evidence'] == 'current_durable' and receipt['operation_state'] == 'committed'
                assert receipt['observed_at'] < committed['confirmation_expires_at']
                assert committed['devices'][0]['name'] == name
                advanced = control(context, base, advance=121000)
                assert advanced['now'] > advanced['confirmation_expires_at']
                refresh = page.get_by_role('button', name='Refresh' if language == 'en' else '刷新', exact=True)
                expect(refresh).to_be_enabled()
                refresh.evaluate('''/* 显式刷新同一读桥，将已推进的服务时间交给页面。 */ button => button.click()''')
                expect(refresh).to_be_enabled()
                expect(page.locator('.read-indicator')).to_have_attribute('data-state', 'current')
                retry = page.get_by_role('button', name='Prepare again' if language == 'en' else '重新准备', exact=True, include_hidden=True)
                expect(page.locator('dialog.operation-dialog')).to_have_attribute('data-phase', 'submitting')
                retained(page, retry, 'submitting')
                if reconcile:
                    page.get_by_role('button', name='Cancel wait' if language == 'en' else '取消等待', exact=True).click()
                    retained(page, retry, 'unconfirmed')
                    control(context, base, mode='release')
                    control(context, base, mode='hold_lookup')
                    page.get_by_role('button', name='Check original receipt' if language == 'en' else '查询原操作回执', exact=True).click()
                    page.wait_for_function('''/* 原关联查询实际完成后仅延迟交付，不伪造回执。 */ async () => {
                        const response = await fetch('/__fixture'); const data = await response.json();
                        return data.held && data.requests.length === 2;
                    }''')
                    retained(page, retry, 'checking')
                control(context, base, mode='release')
                page.locator('dialog.operation-dialog[data-phase="committed"]').wait_for()
                expect(page.locator('.operation-facts')).to_contain_text(original['request_id'])
                data = metadata(context, base)
                assert writes(context, base) == ['devices_rename']
                assert data['calls'].count('confirmations_create') == data['calls'].count('confirmations_confirm') == 1
                assert [request['operation'] for request in data['requests']] == (['devices_rename', 'operations_get'] if reconcile else ['devices_rename'])
                assert all(scope(request) == original for request in data['requests'])
                assert all(scope(result) == original for result in data['receipts'])
                assert data['devices'][1]['name'] == devices[1]['name']
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path=str(output / f'{language}-{width}-{"lookup" if reconcile else "reply"}.png'))
                checks.append({'language': language, 'theme': theme, 'width': width, 'receipt_lookup': reconcile,
                               'original_operation': original, 'device_submissions': 1, 'receipt_observed_at': receipt['observed_at'],
                               'original_deadline': committed['confirmation_expires_at'], 'after_deadline': advanced['now']})
                context.close()
        browser.close()
    assert not errors, errors
    report = {'passed': len(checks), 'checks': checks, 'page_errors': errors,
              'production_browser_entry_verified': True, 'real_temporary_store_and_handler': True,
              'real_user_devices_verified': False}
    (output / 'retry-deadline.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
