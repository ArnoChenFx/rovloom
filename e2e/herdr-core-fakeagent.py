"""e2e 用的假智能体：模拟 OSC 7501 状态机，并把每次输入记成一轮。
启动即报 idle；每收到一行报 working，打印「working on: <行>」，等 WORK 秒报 done，再打印 done。
用法：python3 -I e2e/herdr-core-fakeagent.py <日志路径> [WORK 秒数，默认 0.6]
"""
import os
import sys
import time

LOG = sys.argv[1]
WORK = float(sys.argv[2]) if len(sys.argv) > 2 else 0.6
fd = sys.stdin.fileno()


def osc(state):
    sys.stdout.write(f'\x1b]7501;state={state}:app=fakeagent\x1b\\')
    sys.stdout.flush()


osc('idle')
buf = b''
with open(LOG, 'ab', buffering=0) as log:
    log.write(b'ready\n')
    while True:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        log.write(('%.3f ' % time.time()).encode() + repr(data).encode() + b'\n')
        buf += data
        while b'\n' in buf or b'\r' in buf:
            cut = min(x for x in (buf.find(b'\n'), buf.find(b'\r')) if x >= 0)
            line, buf = buf[:cut], buf[cut + 1:]
            if not line.strip():
                continue
            osc('working')
            sys.stdout.write('working on: ' + line.decode(errors='replace') + '\r\n')
            sys.stdout.flush()
            time.sleep(WORK)
            osc('done')
            sys.stdout.write('done\r\n')
            sys.stdout.flush()
