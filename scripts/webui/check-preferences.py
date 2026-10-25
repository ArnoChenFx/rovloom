#!/usr/bin/env python3
"""在真实 Chromium 验证语言、主题与偏好存储；仅使用显式隔离 fixture，不证明生产会话或设备链路。"""
import os
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

WORDS = {
    'zh-CN': {'title': 'Rovloom 管理', 'language': '语言', 'theme': '主题', 'refresh': '刷新',
              'cancel': '取消读取', 'unavailable': '管理读取尚不可用', 'unauthenticated': '管理会话未登录或已过期',
              'forbidden': '没有此范围的查看权限', 'stale': '设备观测已过期', 'unknown': '连接未核实'},
    'en': {'title': 'Rovloom Management', 'language': 'Language', 'theme': 'Theme', 'refresh': 'Refresh',
           'cancel': 'Cancel read', 'unavailable': 'Management reads are unavailable',
           'unauthenticated': 'The management session is missing or expired',
           'forbidden': 'cannot view this scope', 'stale': 'Device observation expired', 'unknown': 'Connection unverified'}
}


def contrast_check(page):
    """从实际渲染读取前景/有效背景，检查普通文字与状态标签的4.5:1对比度。"""
    ratios = page.evaluate('''/* 只读检查当前DOM中的实际文字对比度。 */ () => {
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const context=canvas.getContext('2d');
      /** 将浏览器计算色值解析成RGBA，不改页面样式。 */
      function rgb(color) { context.clearRect(0,0,1,1); context.fillStyle=color; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data]; }
      /** 按WCAG公式计算线性相对亮度。 */
      function luminance(color) { const channels=color.slice(0,3).map(/* 将色彩通道转换为线性亮度。 */ value=>{const s=value/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4});return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722; }
      /** 沿父元素寻找真正承载文字的不透明背景。 */
      function background(element) { for(let node=element;node;node=node.parentElement){const value=rgb(getComputedStyle(node).backgroundColor);if(value[3]===255)return value;}return [255,255,255,255]; }
      return [...document.querySelectorAll('.badge, .muted, main a, dt')].filter(/* 排除没有文字的节点。 */ element=>element.textContent.trim()).map(/* 逐节点比较文字与背景亮度。 */ element=>{
        const foreground=luminance(rgb(getComputedStyle(element).color));const behind=luminance(background(element));return (Math.max(foreground,behind)+0.05)/(Math.min(foreground,behind)+0.05);
      });
    }''')
    assert ratios and min(ratios) >= 4.5, min(ratios)


class PreferenceControl:
    """Operate the same one-click controls users see."""

    def __init__(self, page, kind):
        self.root = page.locator(f'[data-preference="{kind}"]')
        self.trigger = self.root.locator('.preference-trigger')

    def choose(self, value):
        assert value in ['zh-CN', 'en', 'light', 'dark']
        if self.value() != value:
            self.trigger.click()
        else:
            self.trigger.focus()
        expect(self.trigger).to_be_focused()
        assert self.value() == value

    def value(self):
        return self.trigger.get_attribute('data-value')


def controls(page):
    """取得不随文案改变而失效的两个图标偏好控件。"""
    return PreferenceControl(page, 'language'), PreferenceControl(page, 'theme')


def icon_interactions(page, output, checks):
    """A single pointer or keyboard activation changes the preference with no menu."""
    language, theme = controls(page)
    route = page.evaluate('location.hash')
    assert page.locator('.preferences select,.preference-panel,[aria-haspopup]').count() == 0
    assert page.locator('.preference-trigger svg[aria-hidden="true"]').count() == 2
    for control in [language, theme]:
        original = control.value()
        target = control.trigger.get_attribute('data-next-value')
        assert original != target
        assert control.trigger.inner_text() == ''
        assert control.trigger.get_attribute('title')
        assert control.trigger.get_attribute('aria-expanded') is None
        control.trigger.click()
        assert control.value() == target
        expect(control.trigger).to_be_focused()
        page.keyboard.press('Enter')
        assert control.value() == original
        page.keyboard.press('Space')
        assert control.value() == target
        page.keyboard.press('Tab')
        expect(control.trigger).not_to_be_focused()
        control.trigger.click()
        assert control.value() == original
        control.trigger.dblclick()
        assert control.value() == original
    assert route == page.evaluate('location.hash')
    for width in [320,480,481,760,761,1050,1051,1440]:
        page.set_viewport_size({'width':width,'height':960})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        brand = page.locator('.brand').bounding_box()
        first = language.trigger.bounding_box()
        assert brand['x'] + brand['width'] <= first['x'] or brand['y'] + brand['height'] <= first['y']
        for control in [language,theme]:
            control.trigger.click()
            box = control.trigger.bounding_box()
            assert box['x'] >= 0 and box['x'] + box['width'] <= width
        assert page.locator('.preference-panel').count() == 0
    language.trigger.focus()
    page.keyboard.press('Tab')
    expect(theme.trigger).to_be_focused()
    page.evaluate("location.hash='#machine=fixture-a'")
    page.locator('.provider-card').first.wait_for()
    expect(page.locator('main')).to_be_focused()
    checks.append('one-click language/theme toggles: pointer, Enter/Space, stable focus, no menus, repeated activation, navigation and eight viewport widths')



def first_paint(browser, base, output, checks, page_error):
    """暂停主模块，核对保存主题在首次绘制前生效且无需主模块装载。"""
    records = []
    for system, saved, background in [('light', 'dark', 'rgb(16, 24, 19)'), ('dark', 'light', 'rgb(247, 249, 245)')]:
        context = browser.new_context(locale='en-US', color_scheme=system, viewport={'width': 900, 'height': 650})
        context.add_init_script("localStorage.setItem('rovloom.webui.theme'," + json.dumps(saved) + ");window.themePaints=[];new PerformanceObserver(/** 捕获实际首帧属性和背景，不依赖模块完成后的断言。 */list=>{for(const entry of list.getEntries())window.themePaints.push({name:entry.name,theme:document.documentElement.dataset.theme,background:getComputedStyle(document.documentElement).backgroundColor})}).observe({type:'paint',buffered:true})")
        page = context.new_page()
        page.on('pageerror', page_error)
        held = []

        def hold(route):
            """只暂停既有主模块，首屏经典初始化资源照常加载。"""
            held.append(route)

        page.route('**/browser.js', hold)
        page.goto(base + '/', wait_until='commit')
        page.wait_for_selector('body', state='attached')
        expect(page.locator('html')).to_have_attribute('data-theme', saved)
        page.wait_for_function('''/* 等待CSS完成但保持主模块暂停。 */ (expected)=>getComputedStyle(document.documentElement).backgroundColor===expected''', arg=background)
        assert held
        assert page.locator('#rovloom-management').inner_text() == ''
        assert page.evaluate('''/** 检查初始化脚本仍是同步经典脚本。 */ ({})=>{const script=document.querySelector('script[src="./theme.js"]');return script.type===''&&!script.async&&!script.defer}''', {})
        # 主模块暂停时文档仍在加载，Playwright 的截图会一直等待字体就绪；这里只做属性/背景断言，不截图。
        page.wait_for_function('''/* 验证浏览器已交付真实first-paint记录。 */ ()=>window.themePaints.some(/** 仅筛选首次绘制。 */entry=>entry.name==='first-paint')''')
        paints = page.evaluate('window.themePaints')
        assert all(paint['theme'] == saved and paint['background'] == background for paint in paints), paints
        records.append({'system': system, 'saved': saved, 'main_module_paused': True, 'paints': paints})
        for route in held:
            route.continue_()
        page.get_by_text(WORDS['en']['unavailable'], exact=False).wait_for()
        assert page.locator('html').get_attribute('data-theme') == saved
        checks.append(f'first paint: saved {saved} overrides system {system} before CSS/main module; paint timing verified')
        context.close()
    context = browser.new_context(locale='en-US', color_scheme='light')
    context.add_init_script("localStorage.setItem('rovloom.webui.theme','system')")
    page = context.new_page()
    page.on('pageerror', page_error)
    held = []

    def hold_system(route):
        """系统默认也暂停主模块，验证CSS在初始化期间保持动态。"""
        held.append(route)

    page.route('**/browser.js', hold_system)
    page.goto(base + '/', wait_until='commit')
    page.wait_for_selector('body', state='attached')
    page.wait_for_function("() => getComputedStyle(document.documentElement).backgroundColor==='rgb(247, 249, 245)'")
    assert page.locator('html').get_attribute('data-theme') is None
    page.emulate_media(color_scheme='dark')
    page.wait_for_function("() => getComputedStyle(document.documentElement).backgroundColor==='rgb(16, 24, 19)'")
    assert page.locator('html').get_attribute('data-theme') is None
    assert page.locator('#rovloom-management').inner_text() == ''
    for route in held:
        route.continue_()
    page.get_by_text(WORDS['en']['unavailable'], exact=False).wait_for()
    expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
    records.append({'saved': 'system', 'main_module_paused': True, 'system_change_before_main': 'light to dark', 'css_followed_system': True})
    checks.append('before main module: system preference keeps live CSS system theme changes')
    context.close()
    (output / 'first-paint.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')


def main():
    """在全新浏览器上下文检查两语两主题、系统变化、保存回退和认证失败生命周期。"""
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
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    base = args.url.rstrip('/')
    checks = []
    errors = []

    def page_error(error):
        """只收集隔离页面运行时异常，不读取管理正文或凭据。"""
        errors.append(str(error))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True)
        first_paint(browser, base, output, checks, page_error)
        icon_context = browser.new_context(locale='zh-CN', color_scheme='light')
        icon_page = icon_context.new_page()
        icon_page.on('pageerror', page_error)
        icon_page.goto(base + '/fixtures/')
        icon_page.locator('.device-card').first.wait_for()
        icon_interactions(icon_page, output, checks)
        icon_context.close()
        for language, locale in [('zh-CN', 'zh-TW'), ('en', 'en-GB')]:
            for theme in ['light', 'dark']:
                words = WORDS[language]
                other = 'en' if language == 'zh-CN' else 'zh-CN'
                context = browser.new_context(locale=locale, color_scheme=theme, viewport={'width': 1280, 'height': 960})
                page = context.new_page()
                page.on('pageerror', page_error)
                response = page.goto(base + '/')
                page.get_by_text(words['unavailable'], exact=False).wait_for()
                assert page.title() == words['title']
                assert page.locator('html').get_attribute('lang') == language
                assert page.locator('html').get_attribute('data-theme') == theme
                assert page.evaluate("CSS.supports('color', 'light-dark(white, black)')")
                assert page.get_by_role('button', name=words['language'], exact=True).count() == 1
                assert page.get_by_role('button', name=words['theme'], exact=True).count() == 1
                assert page.evaluate('localStorage.length + sessionStorage.length') == 0
                assert page.evaluate('typeof window.webUiFixture') == 'undefined'
                csp = response.headers['content-security-policy']
                assert 'unsafe-inline' not in csp and 'unsafe-eval' not in csp
                checks.append(f'{language}/{theme}: browser/system defaults, localized metadata and protected unavailable entry')

                page.goto(base + '/fixtures/')
                page.locator('.device-card').first.wait_for()
                device_name = page.locator('.device-name').first.inner_text()
                page.locator('.device-name').first.click()
                page.locator('.provider-card').first.wait_for()
                assert page.get_by_role('heading', name=device_name, exact=True).count() == 1
                assert page.locator('main code').first.inner_text() == 'fixture-a'
                logo = page.get_by_role('img', name='Rovloom', exact=True)
                assert logo.evaluate('/* 核对品牌原图与实际显示尺寸。 */ (el)=>el.complete&&el.naturalWidth===2172&&el.naturalHeight===724&&Math.abs(el.getBoundingClientRect().width/el.getBoundingClientRect().height-3)<0.01')
                contrast_check(page)
                page.evaluate("window.webUiFixture.mode='hold'")
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                page.wait_for_function('/* 只等隔离请求进入挂起。 */ ()=>window.webUiFixture.pending.length===1')
                before = page.evaluate('({reads:window.webUiFixture.reads,aborted:window.webUiFixture.aborted,hash:location.hash})')
                language_control, theme_control = controls(page)
                language_control.trigger.focus()
                language_control.choose(other)
                assert page.title() == WORDS[other]['title']
                assert page.evaluate('document.activeElement===document.querySelectorAll(".preference-trigger")[0]')
                theme_control.trigger.focus()
                theme_control.choose('dark' if theme == 'light' else 'light')
                after = page.evaluate('({reads:window.webUiFixture.reads,aborted:window.webUiFixture.aborted,hash:location.hash})')
                assert before == after
                assert page.evaluate('window.webUiFixture.pending.length') == 1
                assert page.get_by_role('heading', name=device_name, exact=True).count() == 1
                assert page.locator('main').get_attribute('aria-busy') == 'true'
                checks.append(f'{language}/{theme}: language/theme changes preserve route, device, focus and pending read without cancellation')
                page.get_by_role('button', name=WORDS[other]['cancel'], exact=True).click()
                page.evaluate("window.webUiFixture.mode='normal';window.webUiFixture.release()")
                language_control.choose(language)
                theme_control.choose(theme)
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                expect(page.get_by_role('button', name=words['refresh'], exact=True)).to_be_enabled()
                page.screenshot(path=str(output / f'{language}-{theme}-desktop.png'))
                page.set_viewport_size({'width': 320, 'height': 900})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                language_control.trigger.focus()
                page.keyboard.press('Tab')
                assert theme_control.trigger.evaluate('/* 核对键盘焦点与可见轮廓。 */ (el)=>document.activeElement===el&&getComputedStyle(el).outlineStyle!=="none"')
                page.screenshot(path=str(output / f'{language}-{theme}.png'), full_page=True)
                checks.append(f'{language}/{theme}: official wordmark proportions, text contrast, keyboard focus and 320px layout')

                page.evaluate("window.webUiFixture.mode='stale_children'")
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                page.get_by_text(words['stale'], exact=False).first.wait_for()
                language_control.choose(other)
                assert page.locator('main .badges .good, .provider-card .good').count() == 0
                page.get_by_text(WORDS[other]['stale'], exact=False).first.wait_for()
                language_control.choose(language)
                page.evaluate("window.webUiFixture.mode='unverified'")
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                page.get_by_text(words['unknown'], exact=False).first.wait_for()
                language_control.choose(other)
                page.get_by_text(WORDS[other]['unknown'], exact=False).first.wait_for()
                assert page.locator('main .badges .good, .provider-card .good').count() == 0
                checks.append(f'{language}/{theme}: switching never revives expired or unverified observations')

                for mode, error in [('401', 'unauthenticated'), ('403', 'forbidden'), ('expired', 'unauthenticated')]:
                    page.goto(base + '/fixtures/')
                    page.locator('.device-card').first.wait_for()
                    language_control, theme_control = controls(page)
                    language_control.choose(language)
                    theme_control.choose(theme)
                    page.evaluate('/* 仅调整显式隔离fixture情景。 */ (mode)=>{window.webUiFixture.mode=mode}', mode)
                    page.get_by_role('button', name=words['refresh'], exact=True).click()
                    page.get_by_text(words[error], exact=False).wait_for()
                    count = page.evaluate('window.webUiFixture.reads')
                    language_control.choose(other)
                    theme_control.choose('dark' if theme == 'light' else 'light')
                    page.get_by_text(WORDS[other][error], exact=False).wait_for()
                    assert page.locator('.device-card,.provider-card').count() == 0
                    assert page.get_by_role('button', name=WORDS[other]['refresh'], exact=True).is_disabled()
                    assert page.evaluate('window.webUiFixture.reads') == count
                checks.append(f'{language}/{theme}: 401/403/session expiry remain cleared and stopped across language/theme changes')

                page.goto(base + '/fixtures/')
                page.locator('.device-card').first.wait_for()
                language_control, theme_control = controls(page)
                language_control.choose('en')
                theme_control.choose('dark')
                page.reload()
                page.locator('.device-card').first.wait_for()
                assert page.locator('html').get_attribute('lang') == 'en'
                assert page.locator('html').get_attribute('data-theme') == 'dark'
                assert page.evaluate('Object.fromEntries(Object.entries(localStorage))') == {'rovloom.webui.language': 'en', 'rovloom.webui.theme': 'dark'}
                assert page.evaluate('sessionStorage.length') == 0
                checks.append(f'{language}/{theme}: reload restores only the two fixed non-sensitive preference keys')
                context.close()

        context = browser.new_context(locale='zh-CN', color_scheme='light')
        page = context.new_page()
        page.on('pageerror', page_error)
        page.goto(base + '/fixtures/')
        page.locator('.device-card').first.wait_for()
        language_control, theme_control = controls(page)
        page.locator('.device-name').first.focus()
        focused = page.locator('.device-name').first.get_attribute('href')
        page.evaluate("Object.defineProperty(navigator,'languages',{configurable:true,value:['en-US']});window.dispatchEvent(new Event('languagechange'))")
        assert page.locator('html').get_attribute('lang') == 'en'
        assert page.evaluate('document.activeElement.getAttribute("href")') == focused
        page.emulate_media(color_scheme='dark')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        language_control.choose('zh-CN')
        theme_control.choose('light')
        page.evaluate("window.dispatchEvent(new Event('languagechange'))")
        page.emulate_media(color_scheme='light')
        page.emulate_media(color_scheme='dark')
        assert page.locator('html').get_attribute('lang') == 'zh-CN'
        assert page.locator('html').get_attribute('data-theme') == 'light'
        checks.append('system language/theme changes are live; manual choices remain independent; focused route link survives localization')
        page.goto(base + '/fixtures/#machine=fixture-a')
        page.locator('.provider-card').first.wait_for()
        language_control, theme_control = controls(page)
        language_control.choose('en')
        page.evaluate("window.webUiFixture.mode='near_stale'")
        page.get_by_role('button', name='Refresh', exact=True).click()
        page.get_by_text('Management readiness: Ready (ready)', exact=True).wait_for()
        count = page.evaluate('window.webUiFixture.reads')
        language_control.choose('zh-CN')
        theme_control.choose('light')
        page.get_by_text('连接观测已过期', exact=False).first.wait_for(timeout=3500)
        assert page.locator('main .badges .good,.provider-card .good').count() == 0
        assert page.evaluate('window.webUiFixture.reads') == count
        checks.append('language/theme switches preserve the original monotonic expiry boundary without a new read')
        page.evaluate("Object.defineProperty(navigator,'languages',{configurable:true,value:['en-US']})")
        page.evaluate("localStorage.removeItem('rovloom.webui.language');localStorage.removeItem('rovloom.webui.theme')")
        page.reload()
        page.locator('.provider-card').first.wait_for()
        before = page.evaluate('({language:document.documentElement.lang,theme:document.documentElement.dataset.theme})')
        page.evaluate("window.webUiFixture.dispose();Object.defineProperty(navigator,'languages',{configurable:true,value:['en-US']});window.dispatchEvent(new Event('languagechange'))")
        page.emulate_media(color_scheme='light')
        page.wait_for_timeout(100)
        assert page.locator('#rovloom-management').inner_text() == ''
        assert page.evaluate('({language:document.documentElement.lang,theme:document.documentElement.dataset.theme})') == before
        checks.append('unmount removes native language/theme listeners and never recreates disposed content')
        context.close()

        for failure in ['invalid', 'blocked', 'quota']:
            context = browser.new_context(locale='en-US', color_scheme='dark')
            if failure == 'invalid':
                context.add_init_script("if(localStorage.getItem('rovloom.webui.language')===null){localStorage.setItem('rovloom.webui.language','{principal_id:fake}');localStorage.setItem('rovloom.webui.theme','javascript:fake')}localStorage.setItem('other-app.preference','preserve')")
            elif failure == 'blocked':
                context.add_init_script("Object.defineProperty(window,'localStorage',{/** 模拟隐私策略拒绝访问存储。 */get(){throw new DOMException('blocked','SecurityError')}})")
            else:
                context.add_init_script("Storage.prototype.setItem=/** 模拟存储配额拒绝保存。 */function(){throw new DOMException('full','QuotaExceededError')}")
            page = context.new_page()
            page.on('pageerror', page_error)
            page.goto(base + '/fixtures/')
            page.locator('.device-card').first.wait_for()
            assert page.locator('html').get_attribute('lang') == 'en'
            assert page.locator('html').get_attribute('data-theme') == 'dark'
            language_control, theme_control = controls(page)
            assert language_control.value() == 'en'
            assert theme_control.value() == 'dark'
            language_control.choose('zh-CN')
            theme_control.choose('light')
            assert page.locator('html').get_attribute('lang') == 'zh-CN'
            assert page.locator('html').get_attribute('data-theme') == 'light'
            page.reload()
            page.locator('.device-card').first.wait_for()
            assert page.locator('html').get_attribute('lang') == ('zh-CN' if failure == 'invalid' else 'en')
            assert page.locator('html').get_attribute('data-theme') == ('light' if failure == 'invalid' else 'dark')
            if failure == 'invalid':
                assert page.evaluate("localStorage.getItem('other-app.preference')") == 'preserve'
            assert page.evaluate('sessionStorage.length') == 0
            checks.append(f'{failure} storage: safe defaults, working in-memory choices and explicit reload behavior')
            context.close()
        browser.close()
    assert not errors, errors
    report = {'passed': len(checks), 'checks': checks, 'page_errors': errors,
              'evidence': 'synthetic UI projection in real Chromium',
              'management_backend_verified': False, 'real_connector_verified': False}
    (output / 'preferences.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
