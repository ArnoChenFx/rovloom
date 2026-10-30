"""e2e 用的「等人批准」程序：启动即上报 OSC 7501 blocked(permission)，并把收到的每段输入记到日志。
终端设成 raw，ESC、回车这类不带换行的按键也会立刻被读到。
用法：python3 -I e2e/herdr-core-blocked.py <日志路径>
"""
import os
import sys
import termios
import time
import tty

LOG = sys.argv[1]
fd = sys.stdin.fileno()
termios.tcgetattr(fd)
tty.setraw(fd)
sys.stdout.write('\x1b]7501;state=blocked:kind=permission:app=rovloom-e2e\x1b\\')
sys.stdout.write('Allow this action? [y/N] ')
sys.stdout.flush()
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
