#!/usr/bin/env python3
"""Windows 上按 Quick Start 在真实控制台（ConPTY）里从零完成 Gateway + Connector 首次配对，并附着官方 Herdr 或 Luvus。

依赖 pywinpty（pip install pywinpty）。两个角色各用独立的用户目录（USERPROFILE/APPDATA/LOCALAPPDATA）和真实 ConPTY，
Herdr 通过 PATH 被自动发现。就绪后把 MCP 连接信息写入 <work>\\mcp.json，并可选执行 --then 命令
（环境变量 MCP_CONFIG 指向该文件），结束时停止两个角色并清理本次部署用到的 Herdr 进程。

用法：python e2e\\quickstart_windows.py --binary C:\\path\\rovloom.exe (--herdr-dir DIR | --luvus-dir DIR) [--then "cmd ..."]
"""
import argparse, json, os, queue, re, shlex, shutil, subprocess, sys, tempfile, threading, time

from winpty import PtyProcess

# 提示是中英双语；Windows 的默认控制台编码打印不了中文。
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r')
CODE = re.compile(r'm_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+')
JOIN = re.compile(r'wss?://[^#\s]+#m_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+')


class Term:
    """子进程独占一个 ConPTY（等价于用户开的一个真实本地控制台）；后台线程持续收集输出。"""

    def __init__(self, name, cmd, env, cwd):
        self.name, self.buf, self.log = name, '', ''
        self.lock = threading.Lock()
        self.proc = PtyProcess.spawn(cmd, cwd=cwd, env=env, dimensions=(50, 220))
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            try:
                data = self.proc.read(4096)
            except EOFError:
                return
            except Exception:
                return
            if data:
                with self.lock:
                    self.buf += data
                    self.log += data

    def pump(self, timeout=0.2):
        time.sleep(timeout)

    def text(self):
        with self.lock:
            return ANSI.sub('', self.buf)

    def clean_log(self):
        with self.lock:
            return ANSI.sub('', self.log)

    def reset(self):
        with self.lock:
            self.buf = ''

    def alive(self):
        return self.proc.isalive()

    def expect(self, marker, timeout=60):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            clean = self.text()
            if marker in clean:
                self.reset()
                return clean
            if not self.alive():
                raise RuntimeError(f'{self.name} exited before {marker!r}: {self.clean_log()[-2500:]}')
            time.sleep(0.2)
        raise RuntimeError(f'{self.name} timeout waiting {marker!r}; tail: {self.clean_log()[-2500:]}')

    def send(self, text):
        self.proc.write(text.replace('\n', '\r'))

    def stop(self):
        if self.alive():
            try:
                self.proc.terminate(force=True)
            except Exception:
                pass


def redact(text):
    text = CODE.sub('<CODE>', text)
    text = JOIN.sub('<JOIN>', text)
    return re.sub(r'((?:Bearer|Management password) \(private\)[^:]*: )\S+', r'\1<SECRET>', text).strip()[-1000:]


def user_env(home, extra_path):
    system = os.environ.get('SystemRoot', r'C:\Windows')
    return {
        'USERPROFILE': home, 'HOME': home,
        'APPDATA': os.path.join(home, 'AppData', 'Roaming'),
        'LOCALAPPDATA': os.path.join(home, 'AppData', 'Local'),
        'TEMP': os.path.join(home, 'AppData', 'Local', 'Temp'), 'TMP': os.path.join(home, 'AppData', 'Local', 'Temp'),
        'SystemRoot': system, 'windir': system, 'ComSpec': os.path.join(system, 'System32', 'cmd.exe'),
        'PATHEXT': '.COM;.EXE;.BAT;.CMD', 'LANG': 'C.UTF-8', 'TERM': 'xterm',
        # 固定英文输出，宿主 locale 不影响脚本的提示标记。
        'ROVLOOM_LANG': 'en',
        'PATH': ';'.join([*extra_path, os.path.join(system, 'System32'), system]),
    }


def native_servers(native_dir, exe):
    """本次部署使用的 native server 进程（按可执行文件路径区分），返回 [(pid, 创建时间)]。"""
    script = (
        "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and "
        f"$_.ExecutablePath -ieq '{os.path.join(native_dir, exe)}' -and $_.CommandLine -match 'server' }} | "
        "ForEach-Object { \"$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())\" }"
    )
    out = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', script],
                         capture_output=True, text=True, timeout=60).stdout
    return sorted((int(a), b) for a, b in (line.split() for line in out.splitlines() if line.strip()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--binary', required=True)
    ap.add_argument('--herdr-dir', help='含 herdr.exe 与 conpty 目录的官方 Herdr 目录')
    ap.add_argument('--luvus-dir', help='含 luvus.exe 的官方 Luvus 目录（与 --herdr-dir 二选一）')
    ap.add_argument('--pre-existing', action='store_true',
                    help='先像用户那样启动 Luvus default 会话，再部署 Connector：应附着它而不是再起第二个')
    ap.add_argument('--service', action='store_true',
                    help='就绪后停掉终端 Connector，改由开机任务（登录用户，S4U）运行并验证 MCP 链路')
    ap.add_argument('--kill-luvus', action='store_true', help='同 --kill-herdr，用于 Luvus')
    ap.add_argument('--work', help='工作目录（默认系统临时目录下新建）')
    ap.add_argument('--kill-herdr', action='store_true',
                    help='就绪后强杀 Herdr server：Connector 应自行重建并恢复调用')
    ap.add_argument('--crash', action='store_true', help='就绪后强杀 Connector 再重启，验证无需人工清理即可恢复')
    ap.add_argument('--then', help='就绪后执行的命令，环境变量 MCP_CONFIG 指向连接信息')
    args = ap.parse_args()
    if bool(args.herdr_dir) == bool(args.luvus_dir):
        ap.error('exactly one of --herdr-dir / --luvus-dir is required')
    kind, exe = ('herdr', 'herdr.exe') if args.herdr_dir else ('luvus', 'luvus.exe')
    kill_server = args.kill_herdr or args.kill_luvus
    work = os.path.abspath(args.work or tempfile.mkdtemp(prefix='rq-'))
    os.makedirs(work, exist_ok=True)
    home_g, home_c, tools = (os.path.join(work, n) for n in ('g', 'c', 'bin'))
    if args.service:
        # 开机任务的进程环境来自账户本身，不能被伪造；Connector 使用真实用户目录，状态目录与 PATH 显式写进配置。
        home_c = os.environ['USERPROFILE']
    for home in (home_g, home_c):
        for sub in ('AppData\\Roaming', 'AppData\\Local\\Temp'):
            os.makedirs(os.path.join(home, sub), exist_ok=True)
    os.makedirs(tools, exist_ok=True)
    rov = os.path.join(tools, 'rovloom.exe')
    shutil.copy(args.binary, rov)
    # 路径信任要求每一级祖先不被宽主体写入：runner 的 D:\\a 对所有人可写，故像真实安装在用户目录那样复制一份。
    herdr_dir = os.path.join(work, 'hb')
    shutil.copytree(os.path.abspath(args.herdr_dir or args.luvus_dir), herdr_dir)
    env_g = user_env(home_g, [])
    # Connector 的 PATH 里有 native 所在目录：不写 runtime_bin_dirs，验证默认从 PATH 发现程序。
    env_c = user_env(home_c, [herdr_dir])
    terms = []
    try:
        # 按文档用 config init 生成用户配置文件（新流程没有地址问答）。
        initialized = subprocess.run([rov, 'config', 'init', 'connector'], env=env_c, cwd=home_c,
                                     capture_output=True, text=True, timeout=10)
        assert initialized.returncode == 0 and initialized.stderr == 'config_ready\n', 'connector_init_failed'
        path = os.path.join(home_c, '.config', 'rovloom', 'connector.json')
        cfg = json.load(open(path, encoding='utf-8'))
        if kind == 'herdr':
            cfg['native'] = {'provider': 'herdr'}
        if args.service:
            # 状态目录保持配对时的默认位置（配对后改 data.directory 会让服务找不到已保管凭据）；只显式写入 Herdr 目录。
            cfg.setdefault('native', {})['runtime_bin_dirs'] = [herdr_dir]
        open(path, 'w', encoding='utf-8').write(json.dumps(cfg, indent=2) + '\n')

        existing = []
        if args.pre_existing:
            # 与用户的 TUI 自动拉起的 server 同形态：`luvus --session default server`，脱离控制台持续运行。
            subprocess.Popen([os.path.join(herdr_dir, exe), '--session', 'default', 'server'], env=env_c, cwd=home_c,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=0x00000008 | 0x00000200)  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            for _ in range(50):
                if os.path.exists(os.path.join(home_c, '.luvus', 'server.pid')):
                    break
                time.sleep(0.2)
            time.sleep(2)
            existing = native_servers(herdr_dir, exe)
            assert len(existing) == 1, f'pre-existing server not found: {existing}'
            print('PRE_EXISTING', existing, flush=True)
        gateway = Term('gateway', [rov, 'gateway', '--issue-code'], env_g, home_g); terms.append(gateway)
        join_value = JOIN.search(gateway.expect('rovloom connector --join ')).group(0)
        connector = Term('connector', [rov, 'connector', '--join', join_value], env_c, home_c); terms.append(connector)
        deadline, ready = time.time() + 240, False
        while time.time() < deadline and not ready:
            time.sleep(1.0)
            for term in (connector, gateway):
                text = term.text()
                if text.strip().endswith('[y/N]'):
                    print(f'[{term.name}]', redact(text), '\n  -> y', flush=True)
                    term.reset(); term.send('y\n')
            if 'provider_ready=true' in connector.clean_log():
                ready = True
            for term in (connector, gateway):
                if not term.alive():
                    raise RuntimeError(f'{term.name} exited: {redact(term.text())}')
        if not ready:
            raise RuntimeError('timeout waiting for provider_ready; connector tail: ' + redact(connector.clean_log()))
        log = connector.clean_log()
        info = {'url': re.search(r'MCP URL: (\S+)', log).group(1),
                'token': re.search(r'Bearer \(private\): (\S+)', log).group(1),
                'targets': [{'machine_id': join_value.split('#')[1].split('.')[0],
                             'provider_id': 'herdr' if kind == 'herdr' else 'luvus',
                             'profile': 'session', 'session': 'default'}]}
        out = os.path.join(work, 'mcp.json')
        open(out, 'w').write(json.dumps(info))
        print('READY', json.dumps({'mcp_url': info['url'], 'targets': info['targets'], 'config': out}), flush=True)
        servers = native_servers(herdr_dir, exe)
        print('SERVERS', servers, flush=True)
        if args.pre_existing:
            assert servers == existing, f'Connector must attach, not start another: {existing} -> {servers}'
        status = 0
        if args.service:
            account = os.environ['USERNAME']
            run = lambda *a: subprocess.run([rov, 'service', *a], capture_output=True, encoding='utf-8',
                                            errors='replace', timeout=120)
            connector.proc.terminate(force=True)  # 终端 Connector 退出，之后只由开机任务提供原生
            time.sleep(2.0)
            for step in (['install', '--role', 'connector', '--workdir', home_c, '--user', account, '--config', path],
                         ['start', '--role', 'connector']):
                done = run(*step)
                print('SERVICE', step[0], done.returncode, (done.stdout + done.stderr).strip()[:400], flush=True)
                assert done.returncode == 0, f'service {step[0]} failed'
            print('SERVICE_STARTED', flush=True)
        if kill_server:
            before = native_servers(herdr_dir, exe)
            assert before, 'no server to kill'
            for pid, _ in before:
                subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', f'Stop-Process -Id {pid} -Force'],
                               capture_output=True, timeout=60)
            deadline, after = time.time() + 90, []
            while time.time() < deadline:
                time.sleep(1.0)
                after = [entry for entry in native_servers(herdr_dir, exe) if entry not in before]
                if after:
                    break
            assert after, 'Connector did not recreate the server'
            print('SERVER_RECREATED', before, '->', after, flush=True)
            time.sleep(8)  # 给 Connector 结束旧连接周期并重连留出时间
        if args.crash:
            connector.proc.terminate(force=True)  # TerminateProcess：不给产品任何清理机会
            time.sleep(1.0)
            restarted = Term('connector-restarted', [rov, 'connector'], env_c, home_c); terms.append(restarted)
            restarted.expect('provider_ready=true', timeout=90)
            connector = restarted
            print('RECOVERED', flush=True)
        if args.then:
            for attempt in range(8 if args.service else 1):
                done = subprocess.run(shlex.split(args.then, posix=False), env={**os.environ, 'MCP_CONFIG': out},
                                      capture_output=True, encoding='utf-8', errors='replace')
                if done.returncode == 0 or attempt == (7 if args.service else 0):
                    break
                time.sleep(10.0)  # 开机任务 Connector 尚在连接：MCP 链路成功本身就是就绪证明
            if args.service and done.returncode != 0:
                for title, command in (
                    ('TASK', 'schtasks /query /tn rovloom-connector /v /fo list'),
                    ('PROCESSES', "Get-CimInstance Win32_Process -Filter \"Name='rovloom.exe'\" | "
                                  "Select-Object ProcessId,ParentProcessId,CommandLine | Format-List | Out-String"),
                ):
                    probe = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', command],
                                           capture_output=True, encoding='utf-8', errors='replace', timeout=60)
                    print(title, (probe.stdout + probe.stderr)[-1500:], flush=True)
            status = done.returncode
            print(done.stdout, done.stderr, sep='\n', flush=True)
            if status != 0:
                print('--- gateway tail ---\n' + redact(gateway.clean_log()[-3000:]), flush=True)
                print('--- connector tail ---\n' + redact(connector.clean_log()), flush=True)
        sys.exit(status)
    finally:
        for term in reversed(terms):
            term.stop()
        if args.service:
            # 先让任务收到正常停止请求，再撤销开机登记；尽力而为，不影响测试结论。
            for step in (['stop', '--role', 'connector'], ['uninstall', '--role', 'connector']):
                try:
                    done = subprocess.run([rov, 'service', *step], capture_output=True, encoding='utf-8',
                                          errors='replace', timeout=120)
                    print('SERVICE', step[0], done.returncode, (done.stdout + done.stderr).strip()[:200], flush=True)
                except Exception as error:
                    print('SERVICE', step[0], 'error', error, flush=True)
        # 自建的 native 是用户的持久会话，Connector 退出后仍在运行；测试结束时清理本次部署的进程。
        subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command',
                        f"Get-Process {kind} -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -ieq '{os.path.join(herdr_dir, exe)}' }} | Stop-Process -Force"],
                       capture_output=True, timeout=60)


if __name__ == '__main__':
    main()
