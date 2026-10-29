#!/usr/bin/env python3
"""按 Quick Start 在真实终端（pty）里从零完成 Gateway + Connector 首次配对和 Herdr 原生初始化。

只依赖 Python 3 标准库。两个角色各用独立 HOME、真实 TTY、真实产物；Herdr 通过 PATH 被自动发现。
就绪后把 MCP 连接信息写入 <work>/mcp.json，并可选执行 --then 命令（环境变量 MCP_CONFIG 指向该文件），
结束时优雅停止两个角色。

用法：python3 e2e/quickstart.py --binary /path/rovloom --herdr /path/herdr-0.9.5 [--work DIR] [--then 'cmd ...']
"""
import argparse, socket, hashlib, fcntl, getpass, json, os, pty, re, select, shlex, shutil, signal, subprocess, sys, tempfile, termios, time

ANSI = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\r')
CODE = re.compile(r'm_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+')
JOIN = re.compile(r'wss?://[^#\s]+#m_[0-9a-f-]{36}\.[0-9a-f-]{36}\.[A-Za-z0-9_-]+')


class Term:
    """子进程独占一个 pty 并成为其控制终端，等价于用户开的一个真实本地终端。"""

    def __init__(self, name, cmd, env, cwd):
        self.name, self.buf, self.log = name, b'', b''
        self.master, slave = pty.openpty()
        self.child = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, cwd=cwd,
                                      start_new_session=True,
                                      preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
        os.close(slave)

    def pump(self, timeout=0.2):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if select.select([self.master], [], [], 0.05)[0]:
                try:
                    data = os.read(self.master, 4096)
                except OSError:
                    return
                if not data:
                    return
                self.buf += data
                self.log += data

    def text(self):
        return ANSI.sub(b'', self.buf).decode('utf8', 'replace')

    def expect(self, marker, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump(0.2)
            clean = self.text()
            if marker in clean:
                self.buf = b''
                return clean
            if self.child.poll() is not None:
                raise RuntimeError(f'{self.name} exited {self.child.returncode} before {marker!r}: {redact(clean)[-600:]}')
        raise RuntimeError(f'{self.name} timeout waiting {marker!r}; tail: {redact(self.text())[-600:]}')

    def send(self, text):
        os.write(self.master, text.encode())

    def stop(self):
        if self.child.poll() is None:
            self.child.send_signal(signal.SIGTERM)
            try:
                self.child.wait(10)
            except subprocess.TimeoutExpired:
                self.child.kill()


def luvus_servers(binary_dir):
    """本次部署使用的 Luvus server 进程（按可执行文件目录区分），返回 [(pid, 启动标识)]。

    Linux 读 /proc（启动标识是内核启动 tick）；macOS 没有 /proc，用 ps（启动标识是 lstart，秒级足以区分重建）。
    """
    found = []
    if sys.platform == 'darwin':
        listing = subprocess.run(['ps', '-axo', 'pid=,lstart=,command='], capture_output=True, text=True).stdout
        for line in listing.splitlines():
            # 格式：<pid> <Mon Day HH:MM:SS Year 共 5 个字段> <command...>
            parts = line.split(None, 6)
            if len(parts) < 7 or not parts[0].isdigit():
                continue
            command = parts[6].split()
            if command and command[0].startswith(binary_dir) and command[-1] == 'server' and '--session' in command:
                found.append((int(parts[0]), ' '.join(parts[1:6])))
        return sorted(found)
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        try:
            argv = open(f'/proc/{entry}/cmdline', 'rb').read().split(b'\0')[:-1]
            if argv and argv[0].decode().startswith(binary_dir) and argv[-1] == b'server' and b'--session' in argv:
                stat = open(f'/proc/{entry}/stat').read()
                found.append((int(entry), stat[stat.rindex(')') + 2:].split()[19]))
        except OSError:
            continue
    return sorted(found)


def stop_servers(binary_dir):
    """结束本次部署私有目录里的 herdr/luvus server。

    Connector 在附着模式下自建的 server 会在 Connector 退出后继续运行（这是产品行为），但它们属于本轮私有目录，
    测试结束必须回收，否则每跑一次就留下一个常驻进程。先 TERM，等不到再 KILL。
    """
    for sig, grace in ((signal.SIGTERM, 5.0), (signal.SIGKILL, 2.0)):
        pids = [pid for pid, _ in luvus_servers(binary_dir)]
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        end = time.monotonic() + grace
        while time.monotonic() < end and luvus_servers(binary_dir):
            time.sleep(0.1)


def discard_work(work, keep_state):
    """清理自动创建的工作目录：成功则整个删除；失败或被打断时只留下小体积的状态与日志供排查。

    二进制副本（约 110 MB）和 herdr/luvus 副本（约 16 MB）可再生，任何结果下都删除。
    """
    if not keep_state:
        shutil.rmtree(work, ignore_errors=True)
        return
    for name in ('bin', 'hb'):
        shutil.rmtree(os.path.join(work, name), ignore_errors=True)


def sudo_service(binary, *step):
    """一次性 CI 虚拟机里用已有的免密 sudo 运行 `rovloom service ...`（产品代码自身从不提权）。"""
    return subprocess.run(['/usr/bin/sudo', '-n', '--', binary, 'service', *step],
                          capture_output=True, text=True, timeout=120, env={'LANG': 'C', 'PATH': '/usr/bin:/bin'})


def redact(text):
    text = CODE.sub('<CODE>', text)
    text = JOIN.sub('<JOIN>', text)
    return re.sub(r'((?:Bearer|Management password) \(private\)[^:]*: )\S+', r'\1<SECRET>', text).strip()[-1000:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--binary', required=True)
    ap.add_argument('--upgrade-from', help='先用旧 Rovloom 二进制配对并读取，再原位替换两端，验证原 token/设备凭据/结果句柄')
    ap.add_argument('--herdr', help='官方 herdr 0.9.5 可执行文件')
    ap.add_argument('--luvus', help='官方 luvus 0.14.3 可执行文件（与 --herdr 二选一；走默认的 Luvus 引导）')
    ap.add_argument('--work', help='工作目录（需位于祖先不可被其它用户写入的位置；默认 ~/.rq-*）')
    ap.add_argument('--luvus-mode', choices=['attach', 'managed'], default='attach',
                    help='Luvus 的运行方式（默认 attach：附着用户的 default 会话，没有才自建）')
    ap.add_argument('--pre-existing', action='store_true',
                    help='先像用户那样启动 Luvus default 会话，再部署 Connector：应附着它而不是再起第二个')
    ap.add_argument('--kill-luvus', action='store_true',
                    help='就绪后 kill -9 Luvus server：Connector 应自行重建并恢复调用')
    ap.add_argument('--crash', action='store_true', help='就绪后 kill -9 Connector 再重启，验证无需人工清理即可恢复')
    ap.add_argument('--legacy-wait-output', action='store_true',
                    help='（Luvus）注入旧 policy/raw 字段，重启后用原 test token 验证字段不再限制输出等待')
    ap.add_argument('--unknown-outcome', action='store_true',
                    help='（Luvus）暂停原生后提交写调用并杀掉 Connector：调用必须收敛为 outcome_unknown，且不被重发')
    ap.add_argument('--revoke', action='store_true',
                    help='（Luvus）停止 Gateway 后经正式 Store 撤销设备再重启：调用被拒绝，Connector 不会就绪')
    ap.add_argument('--second-device', action='store_true',
                    help='（Herdr）就绪后重启 Gateway 签发新码，再配对第二台 Connector（独立 HOME）：同一 Bearer 同时访问两台设备')
    ap.add_argument('--repair', action='store_true',
                    help='就绪后重启 Gateway 签发新码并重新执行 join：本机作为新设备重新配对，旧凭据被替换')
    ap.add_argument('--service', action='store_true',
                    help='（macOS，Herdr）就绪后终端 Connector 退出，改由 LaunchDaemon（sudo -n 安装并启动）提供原生连接；'
                         'Connector 使用真实 HOME（服务以所选用户运行），MCP 链路成功即证明服务可用')
    ap.add_argument('--then', help='就绪后执行的命令，环境变量 MCP_CONFIG 指向连接信息')
    args = ap.parse_args()
    if bool(args.herdr) == bool(args.luvus):
        ap.error('exactly one of --herdr / --luvus is required')
    if args.second_device and not args.herdr:
        ap.error('--second-device is a Herdr scenario')
    if args.service and not (args.herdr and sys.platform == 'darwin'):
        ap.error('--service is a macOS Herdr scenario')
    if (args.unknown_outcome or args.revoke) and not args.luvus:
        ap.error('--unknown-outcome / --revoke are Luvus scenarios')
    if args.legacy_wait_output and not args.luvus:
        ap.error('--legacy-wait-output is a Luvus scenario')
    work = os.path.abspath(args.work or tempfile.mkdtemp(prefix='.rq-', dir=os.path.expanduser('~')))
    os.makedirs(work, mode=0o700, exist_ok=True)
    home_g, home_c, tools, herdr_dir = (os.path.join(work, n) for n in ('g', 'c', 'bin', 'hb'))
    if args.service:
        # LaunchDaemon 以所选用户运行并使用其真实 HOME；Connector 的配置、凭据与原生端点都在真实 HOME 下（一次性 CI 虚拟机）。
        home_c = os.path.expanduser('~')
    for d in (home_g, home_c, tools, herdr_dir):
        os.makedirs(d, mode=0o700, exist_ok=True)
    rov = os.path.join(tools, 'rovloom')
    shutil.copy(args.upgrade_from or args.binary, rov); os.chmod(rov, 0o755)
    source, name = (args.herdr, 'herdr') if args.herdr else (args.luvus, 'luvus')
    shutil.copy(source, os.path.join(herdr_dir, name)); os.chmod(os.path.join(herdr_dir, name), 0o700)
    # ROVLOOM_LANG 固定英文输出，宿主 locale 不影响这些脚本的提示标记。
    base = {'LANG': 'C.UTF-8', 'TERM': 'xterm', 'ROVLOOM_LANG': 'en'}
    env_g = {**base, 'HOME': home_g, 'PATH': '/usr/bin:/bin'}
    # Connector 的 PATH 里有 herdr 所在目录：不写 runtime_bin_dirs，验证默认从 PATH 发现程序。
    env_c = {**base, 'HOME': home_c, 'PATH': f'{herdr_dir}:/usr/bin:/bin'}
    terms = []
    gateway = None
    status = finished = None
    # 被 timeout / CI 取消终止时也要走 finally：SIGTERM 默认直接结束解释器，会留下孤儿 server 与工作目录。
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, lambda number, _frame: sys.exit(128 + number))
    try:
        # 按 Quick Start 显式生成 provider 配置，不先启动再 Ctrl-C 或手改 provider。
        initialized = subprocess.run([rov, 'config', 'init', 'connector', '--provider',
                                      'herdr' if args.herdr else 'luvus'],
                                     env=env_c, cwd=home_c, capture_output=True, text=True, timeout=10)
        assert initialized.returncode == 0 and initialized.stderr == 'config_ready\n', 'connector_init_failed'
        path = os.path.join(home_c, '.config', 'rovloom', 'connector.json')
        cfg = json.load(open(path))
        if args.herdr and args.service:
            # LaunchDaemon 的 PATH 只有系统目录：显式列出 herdr 所在目录。
            cfg['native']['runtime_bin_dirs'] = [herdr_dir]
            open(path, 'w').write(json.dumps(cfg, indent=2) + '\n'); os.chmod(path, 0o600)
        elif args.luvus and args.luvus_mode == 'managed':
            # 隔离 Luvus 的 Unix socket 路径需要短目录，属于此特定场景的显式配置。
            cfg['native'] = {'provider': 'luvus', 'luvus': {'mode': 'managed'}}
            cfg['data'] = {'directory': os.path.join(work, 'd')}
            open(path, 'w').write(json.dumps(cfg, indent=2) + '\n'); os.chmod(path, 0o600)

        if args.pre_existing:
            # 与用户的 TUI 自动拉起的 server 同形态：`luvus --session default server`，脱离终端持续运行。
            subprocess.Popen([os.path.join(herdr_dir, 'luvus'), '--session', 'default', 'server'],
                             env={**env_c, 'SHELL': '/bin/sh'}, cwd=home_c, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            for _ in range(50):
                if os.path.exists(os.path.join(home_c, '.luvus', 'luvus.sock')):
                    break
                time.sleep(0.2)
            existing = luvus_servers(herdr_dir)
            assert len(existing) == 1, f'pre-existing server not found: {existing}'
            print('PRE_EXISTING', existing, flush=True)
        # 每轮使用独立端口，避免与同机已有 Gateway 或其它验收进程冲突。
        initialized_gateway = subprocess.run([rov, 'config', 'init', 'gateway'],
                                            env=env_g, cwd=home_g, capture_output=True, text=True, timeout=10)
        assert initialized_gateway.returncode == 0, 'gateway_init_failed'
        gateway_path = os.path.join(home_g, '.config', 'rovloom', 'gateway.json')
        gateway_cfg = json.load(open(gateway_path))
        reserved = [socket.socket() for _ in range(3)]
        try:
            for listener, bound in zip(('devices', 'mcp', 'management'), reserved):
                bound.bind(('127.0.0.1', 0))
                gateway_cfg[listener]['port'] = bound.getsockname()[1]
            open(gateway_path, 'w').write(json.dumps(gateway_cfg, indent=2) + '\n')
        finally:
            for bound in reserved:
                bound.close()
        def issue_join():
            """（重）启动 Gateway 签发一张一机一码，返回完整 join 命令值（ws://...#m...）。"""
            nonlocal gateway
            if gateway is not None:
                gateway.stop()  # 码由 Gateway 状态目录签发；先停旧进程再签发，Connector 会自行重连
            gateway = Term('gateway-issue', [rov, 'gateway', '--issue-code'], env_g, home_g)
            terms.append(gateway)
            printed = gateway.expect('rovloom connector --join ')
            return JOIN.search(printed).group(0)

        join_value = issue_join()
        connector = Term('connector', [rov, 'connector', '--join', join_value], env_c, home_c); terms.append(connector)
        deadline, ready = time.time() + 180, False
        while time.time() < deadline and not ready:
            connector.pump(1.0); gateway.pump(0.3)
            if 'provider_ready=true' in ANSI.sub(b'', connector.log).decode('utf8', 'replace'):
                ready = True
            for term in (connector, gateway):
                if term.child.poll() is not None:
                    raise RuntimeError(f'{term.name} exited {term.child.returncode}: {redact(term.text())}')
        if not ready:
            raise RuntimeError('timeout waiting for provider_ready')
        log = ANSI.sub(b'', connector.log).decode('utf8', 'replace')
        info = {'url': re.search(r'MCP URL: (\S+)', log).group(1),
                'token': re.search(r'Bearer \(private\): (\S+)', log).group(1),
                'targets': [{'machine_id': join_value.split('#')[1].split('.')[0],
                             'provider_id': 'herdr' if args.herdr else 'luvus',
                             'profile': 'session',
                             'session': 'rovloom' if args.luvus and args.luvus_mode == 'managed' else 'default'}]}
        # 管理页口令不再由配对流程打印：另起进程 admin create（Gateway 热加载），写进 mcp.json 供后续页面登录检查，不打印。
        created = subprocess.run([rov, 'admin', 'create'], env=env_g, cwd=home_g, capture_output=True, text=True, timeout=10)
        if created.returncode == 0:
            password = re.search(r'(\S{20,})', created.stdout)
            if password:
                info['admin'] = {'user': 'admin', 'password': password.group(1), 'url': f"http://127.0.0.1:{gateway_cfg['management']['port']}/"}
        out = os.path.join(work, 'mcp.json')
        open(out, 'w').write(json.dumps(info)); os.chmod(out, 0o600)
        print('READY', json.dumps({'mcp_url': info['url'], 'targets': info['targets'], 'config': out}), flush=True)
        status = 0
        if args.luvus:
            servers = luvus_servers(herdr_dir)
            print('LUVUS_SERVERS', servers, flush=True)
            if args.pre_existing:
                assert servers == existing, f'Connector must attach, not start another: {existing} -> {servers}'
        if args.upgrade_from:
            made = subprocess.run([rov, 'token', 'create', '--principal', 'upgrade_test', '--like', 'operator_simple_pairing'],
                                  env=env_g, cwd=home_g, capture_output=True, text=True, timeout=10)
            assert made.returncode == 0, 'upgrade_token_create_failed'
            info['token'] = made.stdout.strip()
            assert re.fullmatch(r'[A-Za-z0-9_-]{43}', info['token']), 'upgrade_token_format'
            open(out, 'w').write(json.dumps(info))
            evidence = os.path.join(work, 'upgrade-evidence.json')
            probe = os.path.join(os.path.dirname(__file__), 'upgrade-client.mjs')
            probe_env = {**os.environ, 'MCP_CONFIG': out, 'UPGRADE_EVIDENCE': evidence}
            subprocess.run(['bun', '--no-env-file', probe, 'before'], env=probe_env, check=True, timeout=60)
            connector.stop(); gateway.stop()
            connector_state = cfg.get('data', {}).get('directory') or os.path.join(home_c, '.local', 'share', 'rovloom', 'connector')
            credential_path = os.path.join(connector_state, 'managed', 'device.json')
            credential_digest = hashlib.sha256(open(credential_path, 'rb').read()).digest()
            # 只替换二进制，不重新 join、不编辑 managed 配对配置或设备凭据。
            shutil.copy(args.binary, rov); os.chmod(rov, 0o755)
            gateway = Term('gateway-upgraded', [rov, 'gateway'], env_g, home_g); terms.append(gateway)
            connector = Term('connector-upgraded', [rov, 'connector'], env_c, home_c); terms.append(connector)
            connector.expect('provider_ready=true', timeout=90)
            assert hashlib.sha256(open(credential_path, 'rb').read()).digest() == credential_digest, 'upgrade_changed_device_credential'
            subprocess.run(['bun', '--no-env-file', probe, 'after'], env=probe_env, check=True, timeout=60)
            # 范围命令触发真实 v2 写盘，原 token 不轮换，旧方法/动作策略不再落盘。
            scoped = subprocess.run([rov, 'token', 'scope', '--principal', 'upgrade_test', '--devices', info['targets'][0]['machine_id']],
                                    env=env_g, cwd=home_g, capture_output=True, text=True, timeout=10)
            assert scoped.returncode == 0, 'upgrade_scope_write_failed'
            registry_path = os.path.join(home_g, '.local', 'share', 'rovloom', 'gateway', 'managed', 'mcp-callers.json')
            registry = json.load(open(registry_path))
            assert registry['schema_version'] == 2
            assert 'local_policy' not in registry and 'gateway_policy' not in registry
            assert all(set(entry['principal']) == {'id'} for entry in registry['callers'])
            subprocess.run(['bun', '--no-env-file', probe, 'after'], env=probe_env, check=True, timeout=60)
            if args.luvus:
                subprocess.run(['bun', '--no-env-file', os.path.join(os.path.dirname(__file__), 'luvus-wait-output.mjs')],
                               env=probe_env, check=True, timeout=90)
            print('NATIVE_UPGRADE_OK', json.dumps({'provider': 'herdr' if args.herdr else 'luvus',
                                                 'credential_preserved': True, 'token_preserved': True,
                                                 'registry_version': 2, 'old_result_readable': True}), flush=True)
        if args.legacy_wait_output:
            # 真实 CLI 创建非配对主体，之后仍使用同一个 token；所有文件仅属于本轮隔离 HOME。
            made = subprocess.run([rov, 'token', 'create', '--principal', 'test', '--like', 'operator_simple_pairing'],
                                  env=env_g, cwd=home_g, capture_output=True, text=True, timeout=10)
            assert made.returncode == 0, 'test_token_create_failed'
            info['token'] = made.stdout.strip()
            assert re.fullmatch(r'[A-Za-z0-9_-]{43}', info['token']), 'test_token_format'
            open(out, 'w').write(json.dumps(info))
            connector.stop(); gateway.stop()
            managed_g = os.path.join(home_g, '.local', 'share', 'rovloom', 'gateway', 'managed')
            connector_state = cfg.get('data', {}).get('directory') or os.path.join(home_c, '.local', 'share', 'rovloom', 'connector')
            managed_c = os.path.join(connector_state, 'managed')
            # 新布局把 provider 准备记录放在 control/<provider>/，旧布局在 managed/；两处都要注入旧字段。
            control_c = os.path.join(connector_state, 'control')
            registry = json.load(open(os.path.join(managed_g, 'mcp-callers.json')))
            assert registry['schema_version'] == 2
            assert 'local_policy' not in registry and 'gateway_policy' not in registry
            assert all('policy' not in entry['principal'] for entry in registry['callers'])
            def downgrade(value):
                changed = 0
                if isinstance(value, dict):
                    if value.get('kind') == 'mcp-caller-source':
                        value['local_policy'] = {'revision': 'legacy_local', 'grants': []}
                        value['gateway_policy'] = {'revision': 'legacy_caller', 'grants': []}
                        for entry in value['callers']:
                            entry['principal']['policy'] = {'revision': 'legacy_caller', 'grants': []}
                        changed += 1
                    if value.get('kind') == 'luvus' and value.get('authentication') == 'local_owner':
                        value['policies'] = {'caller': {'revision': 'legacy_caller', 'grants': []}, 'local': {'revision': 'legacy_local', 'grants': []}}
                        value['peer_policy_revision'] = 'legacy_different'
                        changed += 1
                    if value.get('kind') == 'luvus' and value.get('authentication') == 'remote_connector':
                        value['raw_grant'] = {'principal_id': 'operator_simple_pairing', 'methods': ['session.snapshot']}
                        changed += 1
                    if 'target' in value and isinstance(value.get('actions'), list):
                        value['methods'] = ['pane.list']
                        changed += 1
                    for item in value.values():
                        changed += downgrade(item)
                elif isinstance(value, list):
                    changed += sum(downgrade(item) for item in value)
                return changed
            counts = []
            # 控制记录可能位于 managed/ 顶层（旧布局）或 control/<provider>/（新布局），两者都要覆盖。
            for directory in (managed_g, managed_c, control_c):
                changed = 0
                if not os.path.isdir(directory):
                    continue
                for root, _subdirs, files in os.walk(directory):
                    for filename in files:
                        if not filename.endswith('.json'):
                            continue
                        path = os.path.join(root, filename)
                        value = json.load(open(path))
                        updates = downgrade(value)
                        if updates:
                            open(path, 'w').write(json.dumps(value))
                            changed += updates
                counts.append(changed)
            assert sum(counts) > 0, 'legacy_fixture_missing_policies'
            gateway = Term('gateway-upgraded', [rov, 'gateway'], env_g, home_g); terms.append(gateway)
            connector = Term('connector-upgraded', [rov, 'connector'], env_c, home_c); terms.append(connector)
            connector.expect('provider_ready=true', timeout=90)
            subprocess.run(['bun', '--no-env-file', os.path.join(os.path.dirname(__file__), 'luvus-wait-output.mjs')],
                           env={**os.environ, 'MCP_CONFIG': out}, check=True, timeout=90)
            print('LEGACY_WAIT_OUTPUT_OK', json.dumps({'legacy_policy_blocks': counts}), flush=True)
        if args.kill_luvus:
            before = luvus_servers(herdr_dir)
            for pid, _ in before:
                os.kill(pid, signal.SIGKILL)
            deadline = time.time() + 90
            after = []
            while time.time() < deadline:
                connector.pump(0.5)
                after = [entry for entry in luvus_servers(herdr_dir) if entry not in before]
                if after:
                    break
            assert after, 'Connector did not recreate the Luvus server'
            print('LUVUS_RECREATED', before, '->', after, flush=True)
            time.sleep(8)  # 给 Connector 结束旧连接周期并重连留出时间
        if args.crash:
            connector.child.kill()  # SIGKILL：不给产品任何清理机会
            connector.child.wait(10)
            restarted = Term('connector-restarted', [rov, 'connector'], env_c, home_c); terms.append(restarted)
            restarted.expect('provider_ready=true', timeout=60)
            print('RECOVERED', flush=True)
        def faults(*step):
            command = ['bun', '--no-env-file', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'luvus-faults.mjs'), *step]
            done = subprocess.run(command, env={**os.environ, 'MCP_CONFIG': out, 'LUVUS_WRITE': '{}'},
                                  capture_output=True, text=True, timeout=300)
            print(f'[faults {step[0]}]', (done.stdout + done.stderr).strip()[-600:], flush=True)
            assert done.returncode == 0, f'faults {step[0]} failed'
        if args.unknown_outcome:
            marker = os.path.join(work, 'unknown.json')
            servers = [str(pid) for pid, _ in luvus_servers(herdr_dir)]
            assert servers, 'no Luvus server to pause'
            faults('submit-write', marker, *servers)
            connector.child.kill(); connector.child.wait(10)  # SIGKILL：写请求已发出但未应答
            for pid in servers:
                os.kill(int(pid), signal.SIGCONT)  # 旧原生恢复：它可能执行那一次旧请求，但 Gateway 不得再发第二次
            restarted = Term('connector-restarted', [rov, 'connector'], env_c, home_c); terms.append(restarted)
            restarted.expect('provider_ready=true', timeout=90)
            faults('check-unknown', marker)
            print('UNKNOWN_OUTCOME_OK', flush=True)
        if args.revoke:
            machine = info['targets'][0]['machine_id']
            connector.stop(); gateway.stop()
            faults('revoke', os.path.join(home_g, '.local', 'share', 'rovloom', 'gateway'), machine)
            gateway = Term('gateway-restarted', [rov, 'gateway'], env_g, home_g); terms.append(gateway)
            connector = Term('connector-revoked', [rov, 'connector'], env_c, home_c); terms.append(connector)
            deadline = time.time() + 60
            while True:
                try:
                    faults('check-revoked')
                    break
                except AssertionError:
                    assert time.time() < deadline, 'Gateway never reported the device as revoked'
                    time.sleep(2)
            connector.pump(15.0)
            assert 'provider_ready=true' not in ANSI.sub(b'', connector.log).decode('utf8', 'replace'), \
                'revoked device must not become ready'
            print('REVOKE_OK', flush=True)
        if args.repair:
            # 固定读当前生效的凭据文件：退役副本会留在 retired/ 下，不能作为"新凭据"被扫到。
            device_path = os.path.join(home_c, '.local', 'share', 'rovloom', 'connector', 'managed', 'device.json')
            assert os.path.exists(device_path), 'expected a device credential file'
            old_secret = open(device_path).read()
            connector.stop()
            join_value = issue_join()  # 新码：本机重置本地状态后作为新设备重新配对
            connector = Term('connector-repair', [rov, 'connector', '--join', join_value], env_c, home_c); terms.append(connector)
            connector.expect('pairing_completed')
            deadline, ready = time.time() + 120, False
            while time.time() < deadline and not ready:
                connector.pump(1.0); gateway.pump(0.3)
                ready = 'provider_ready=true' in ANSI.sub(b'', connector.log).decode('utf8', 'replace')
                for term in (connector, gateway):
                    if term.child.poll() is not None:
                        raise RuntimeError(f'{term.name} exited {term.child.returncode}: {redact(term.text())}')
            assert ready, 'timeout waiting for provider_ready after re-pair'
            new_secret = open(device_path).read()
            assert new_secret != old_secret, 'device credential was not replaced'
            info['targets'][0]['machine_id'] = join_value.split('#')[1].split('.')[0]
            open(out, 'w').write(json.dumps(info)); os.chmod(out, 0o600)
            print('REPAIRED', flush=True)
        if args.second_device:
            home_c2 = os.path.join(work, 'c2'); os.makedirs(home_c2, mode=0o700, exist_ok=True)
            env_c2 = {**base, 'HOME': home_c2, 'PATH': f'{herdr_dir}:/usr/bin:/bin'}
            initialized = subprocess.run([rov, 'config', 'init', 'connector', '--provider', 'herdr'],
                                         env=env_c2, cwd=home_c2, capture_output=True, text=True, timeout=10)
            assert initialized.returncode == 0 and initialized.stderr == 'config_ready\n', 'connector2_init_failed'
            join2 = issue_join()  # 第一台 Connector 继续运行，会自行重连新的 Gateway 进程
            connector2 = Term('connector2', [rov, 'connector', '--join', join2], env_c2, home_c2); terms.append(connector2)
            deadline, ready = time.time() + 180, False
            while time.time() < deadline and not ready:
                connector2.pump(1.0); connector.pump(0.3); gateway.pump(0.3)
                ready = 'provider_ready=true' in ANSI.sub(b'', connector2.log).decode('utf8', 'replace') and \
                    'provider_ready=true' in ANSI.sub(b'', connector.log).decode('utf8', 'replace')
                for term in (connector2, connector, gateway):
                    if term.child.poll() is not None:
                        raise RuntimeError(f'{term.name} exited {term.child.returncode}: {redact(term.text())}')
            assert ready, 'timeout waiting for both connectors'
            info['targets'].append({**info['targets'][0], 'machine_id': join2.split('#')[1].split('.')[0]})
            open(out, 'w').write(json.dumps(info)); os.chmod(out, 0o600)
            subprocess.run(['bun', '--no-env-file', os.path.join(os.path.dirname(__file__), 'two-devices-check.mjs')],
                           env={**os.environ, 'MCP_CONFIG': out, 'MCP_TARGETS': json.dumps(info['targets'])},
                           check=True, timeout=180)
            print('SECOND_DEVICE', flush=True)
        if args.service:
            account = getpass.getuser()
            connector.stop()  # 终端 Connector 退出，之后只由开机服务提供原生
            time.sleep(2.0)
            for step in (['install', '--role', 'connector', '--workdir', home_c, '--user', account, '--config', path],
                         ['start', '--role', 'connector']):
                done = sudo_service(rov, *step)
                print('SERVICE', step[0], done.returncode, (done.stdout + done.stderr).strip()[:400], flush=True)
                assert done.returncode == 0, f'service {step[0]} failed'
            print('SERVICE_STARTED', flush=True)
        status = 0
        if args.then:
            status = 1
            # 验收脚本可以核对 Gateway 自己的持久化布局（两台机器部署时设备路径不可见）。
            then_env = {**os.environ, 'MCP_CONFIG': out,
                        'ROVLOOM_EXPECT_LEGACY_SCHEMA': '1' if args.upgrade_from else '',
                        'ROVLOOM_GATEWAY_STATE': os.path.join(home_g, '.local', 'share', 'rovloom', 'gateway')}
            for attempt in range(8 if args.service else 1):
                status = subprocess.call(shlex.split(args.then), env=then_env)
                if status == 0:
                    break
                time.sleep(10.0)  # 服务 Connector 尚在连接：MCP 链路成功本身就是就绪证明
            if status != 0:
                connector.pump(1.0); gateway.pump(0.3)
                print('--- gateway tail ---\n' + redact(ANSI.sub(b'', gateway.log).decode('utf8', 'replace')), flush=True)
                print('--- connector tail ---\n' + redact(ANSI.sub(b'', connector.log).decode('utf8', 'replace')), flush=True)
        finished = status  # 只有跑到这里才算跑完；中途被信号或异常打断时保持 None
        sys.exit(status)
    finally:
        # 清理期间不再响应终止信号，保证清理本身跑完。
        for signum in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(signum, signal.SIG_IGN)
        for term in reversed(terms):
            term.stop()
        if args.service:
            # 先让服务收到正常停止请求，再撤销开机登记；尽力而为，不影响测试结论。
            for step in (['stop', '--role', 'connector'], ['uninstall', '--role', 'connector']):
                try:
                    done = sudo_service(rov, *step)
                    print('SERVICE', step[0], done.returncode, (done.stdout + done.stderr).strip()[:200], flush=True)
                except Exception as error:
                    print('SERVICE', step[0], 'error', error, flush=True)
        # 不论哪个场景，私有目录里的 herdr/luvus server 都属于本轮，不是用户已有的实例；
        # 清理尽力而为，不能盖掉真正的失败。
        try:
            stop_servers(herdr_dir)
        except Exception as error:
            print('CLEANUP servers error', error, flush=True)
        if args.work is None:
            discard_work(work, keep_state=finished != 0)


if __name__ == '__main__':
    main()
