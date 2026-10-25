#!/usr/bin/env python3
"""两台“机器”的 Quick Start 验收：Gateway 与 Connector 各在独立容器里，文件系统互不可见，只通过 Docker 网络上的真实 TCP 通信。

- Gateway 容器：没有 Herdr，设备监听 0.0.0.0，MCP 只在其回环上（客户端容器共享该网络命名空间）；
- Connector 容器：带官方 Herdr，用容器 DNS 名 ws://rv-gw:9443 连接；
- 配对仍在两个容器的真实 TTY（docker run -it，外面套 pty）里按 Quick Start 完成；
- 之后用官方 MCP SDK 客户端从宿主走完整 Herdr 链路，并制造网络断开（docker network disconnect）与恢复。

用法：python3 e2e/two_host.py --binary /path/rovloom --herdr /path/herdr [--image debian:bookworm-slim]
需要 Docker 与 bun（运行 MCP 步骤）。
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quickstart import ANSI, CODE, JOIN, Term, redact  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def docker(*cmd, check=True):
    return subprocess.run(['docker', *cmd], capture_output=True, text=True, check=check)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--binary', required=True)
    ap.add_argument('--herdr', required=True)
    ap.add_argument('--image', default='debian:bookworm-slim')
    ap.add_argument('--work')
    args = ap.parse_args()
    work = os.path.abspath(args.work or tempfile.mkdtemp(prefix='.rq-two-', dir=os.path.expanduser('~')))
    tag = os.path.basename(work).replace('.', '')
    net, gw_name, cn_name = f'rv-net-{tag}', f'rv-gw-{tag}', f'rv-cn-{tag}'
    home_g, home_c, tools, herdr_dir = (os.path.join(work, n) for n in ('g', 'c', 'bin', 'hb'))
    for d in (work, home_g, home_c, tools, herdr_dir):
        os.makedirs(d, mode=0o700, exist_ok=True)
    rov = os.path.join(tools, 'rovloom')
    shutil.copy(args.binary, rov); os.chmod(rov, 0o755)
    shutil.copy(args.herdr, os.path.join(herdr_dir, 'herdr')); os.chmod(os.path.join(herdr_dir, 'herdr'), 0o755)
    uid_gid = f'{os.getuid()}:{os.getgid()}'
    # 容器内固定英文输出，宿主 locale 不影响这些脚本的提示标记。
    common = ['--user', uid_gid, '-e', 'HOME=/home/rv', '-e', 'LANG=C.UTF-8', '-e', 'TERM=xterm',
              '-e', 'ROVLOOM_LANG=en',
              '-v', '/etc/passwd:/etc/passwd:ro', '-v', f'{rov}:/usr/local/bin/rovloom:ro']
    # 两个容器的 HOME 是各自独立的宿主目录；Gateway 看不到 Connector 的目录，反之亦然。
    gateway_cfg = os.path.join(home_g, '.config', 'rovloom'); os.makedirs(gateway_cfg, mode=0o700, exist_ok=True)
    data_g = os.path.join(home_g, '.local', 'share', 'rovloom', 'gateway'); os.makedirs(data_g, mode=0o700, exist_ok=True)
    cfg = {'schema_version': 1, 'role': 'gateway', 'data': {'directory': '/home/rv/.local/share/rovloom/gateway'},
           'mcp': {'hostname': '127.0.0.1', 'port': 9444},
           'devices': {'hostname': '0.0.0.0', 'port': 9443}, 'management': {'enabled': True, 'port': 9445}}
    path_g = os.path.join(gateway_cfg, 'gateway.json')
    open(path_g, 'w').write(json.dumps(cfg, indent=2) + '\n'); os.chmod(path_g, 0o600)
    terms = []
    try:
        docker('network', 'create', net)
        gateway_cmd = ['docker', 'run', '-it', '--rm', '--name', gw_name, '--network', net,
                       *common, '-e', 'PATH=/usr/local/bin:/usr/bin:/bin', '-v', f'{home_g}:/home/rv', args.image, 'rovloom', 'gateway']
        connector_cmd = ['docker', 'run', '-it', '--rm', '--name', cn_name, '--network', net,
                         *common, '-e', 'PATH=/opt/herdr:/usr/local/bin:/usr/bin:/bin', '-v', f'{home_c}:/home/rv',
                         '-v', f'{herdr_dir}:/opt/herdr:ro', args.image, 'rovloom', 'connector']
        env = {**os.environ}
        # 按文档用 config init 生成用户配置并选择 Herdr（新流程没有地址问答）。
        docker('run', '--rm', *common, '-e', 'PATH=/opt/herdr:/usr/local/bin:/usr/bin:/bin',
               '-v', f'{home_c}:/home/rv', '-v', f'{herdr_dir}:/opt/herdr:ro',
               args.image, 'rovloom', 'config', 'init', 'connector', '--provider', 'herdr')
        path_c = os.path.join(home_c, '.config', 'rovloom', 'connector.json')
        assert os.path.exists(path_c), 'connector config not generated'
        cc = json.load(open(path_c)); cc['native'] = {'provider': 'herdr'}
        open(path_c, 'w').write(json.dumps(cc, indent=2) + '\n'); os.chmod(path_c, 0o600)

        # “Gateway 未安装 runtime”：Gateway 容器里找不到 herdr；Connector 容器看不到 Gateway 的数据目录。
        probe = docker('run', '--rm', '--user', uid_gid, '-e', 'PATH=/usr/local/bin:/usr/bin:/bin', args.image, 'sh', '-c', 'command -v herdr || echo absent')
        assert probe.stdout.strip() == 'absent', probe.stdout
        gateway_cmd = gateway_cmd + ['--issue-code']
        gateway = Term('gateway', gateway_cmd, env, home_g); terms.append(gateway)
        join_value = JOIN.search(gateway.expect('rovloom connector --join ')).group(0)
        # 容器内监听地址是通配地址；Connector 必须使用 Docker DNS 的 Gateway 名称。
        join_value = 'ws://' + gw_name + ':9443#' + join_value.split('#', 1)[1]
        connector_cmd = connector_cmd + ['--join', join_value]
        connector = Term('connector', connector_cmd, env, home_c); terms.append(connector)
        deadline, ready = time.time() + 240, False
        while time.time() < deadline and not ready:
            connector.pump(1.0); gateway.pump(0.3)
            for term in (connector, gateway):
                text = term.text()
                if text.strip().endswith('[y/N]'):
                    print(f'[{term.name}]', redact(text), '\n  -> y', flush=True)
                    term.buf = b''; term.send('y\n')
            glog = ANSI.sub(b'', gateway.log).decode('utf8', 'replace')
            clog = ANSI.sub(b'', connector.log).decode('utf8', 'replace')
            ready = 'provider_ready=true' in clog
            for term in (connector, gateway):
                if term.child.poll() is not None:
                    raise RuntimeError(f'{term.name} exited {term.child.returncode}: {redact(term.text())}')
        if not ready:
            raise RuntimeError('timeout waiting for provider_ready\n' + redact(ANSI.sub(b"", connector.log).decode("utf8", "replace")))
        log = ANSI.sub(b'', connector.log).decode('utf8', 'replace')
        info = {'url': re.search(r'MCP URL: (\S+)', log).group(1),
                'token': re.search(r'Bearer \(private\): (\S+)', log).group(1),
                'targets': [{'machine_id': join_value.split('#')[1].split('.')[0], 'provider_id': 'herdr', 'profile': 'session', 'session': 'default'}]}
        out = os.path.join(work, 'mcp.json')
        open(out, 'w').write(json.dumps(info)); os.chmod(out, 0o600)
        print('READY', json.dumps({'mcp_url': info['url'], 'targets': info['targets']}), flush=True)
        # 隔离证据：Connector 容器的文件系统里没有 Gateway 的数据库，Gateway 容器里没有 Connector 的凭据。
        assert 'gateway.db' not in docker('exec', cn_name, 'sh', '-c', 'find /home/rv -name gateway.db').stdout
        assert docker('exec', gw_name, 'sh', '-c', 'find /home/rv -name device.json | head -1').stdout.strip() == ''

        bun = os.path.realpath(shutil.which('bun'))
        repo = os.path.dirname(HERE)

        def mcp(script, *step):
            # MCP 监听只在 Gateway 的回环上（设计如此，远程客户端经反向代理）。客户端容器与 Gateway 共享其网络命名空间，
            # 等价于 Gateway 那台机器上的本机客户端；它看不到 Connector 的任何东西。
            command = ['docker', 'run', '--rm', '--network', f'container:{gw_name}', '--user', uid_gid, '-e', 'HOME=/tmp',
                       '-v', f'{bun}:/usr/local/bin/bun:ro', '-v', f'{repo}:/repo:ro', '-v', f'{out}:/mcp.json:ro',
                       '-e', 'MCP_CONFIG=/mcp.json', '-w', '/repo', args.image, 'bun', '--no-env-file', f'e2e/{script}', *step]
            done = subprocess.run(command, capture_output=True, text=True, timeout=400)
            print('[mcp]', script, *step, (done.stdout + done.stderr).strip()[-500:], flush=True)
            assert done.returncode == 0, 'mcp step failed'
        mcp('herdr-session.mjs')
        check = lambda step: mcp('two-host-check.mjs', step)
        # 网络断开：把 Connector 容器从网络上摘掉，Gateway 判离线，新调用立即不可用而不是悬挂；接回后自动恢复。
        docker('network', 'disconnect', net, cn_name)
        check('unavailable')
        docker('network', 'connect', net, cn_name)
        check('ping')
        print('TWO_HOST_OK', flush=True)
    except Exception:
        for term in terms:
            term.pump(0.5)
            print(f'--- {term.name} tail ---\n' + redact(ANSI.sub(b'', term.log).decode('utf8', 'replace'))[-1500:], flush=True)
        raise
    finally:
        for term in reversed(terms):
            term.stop()
        docker('rm', '-f', gw_name, cn_name, check=False)
        docker('network', 'rm', net, check=False)


if __name__ == '__main__':
    main()
