#!/usr/bin/env python3
# 在全新私有环境采集固定 Luvus 实例的原生过程与传输证据，并负责关闭和清理。
"""在全新私有目录采集固定版本 Luvus 的原生证据；不连接已有实例。"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import shutil
import socket
import stat
import struct
import subprocess
import tempfile
import time


# 计算原始字节的 SHA-256 摘要，供二进制和证据完整性记录。
def digest(data):
    return hashlib.sha256(data).hexdigest()


class Capture:
    # 核对官方二进制摘要，创建私有采集目录与最小子进程环境并初始化记录状态。
    def __init__(self, binary, output):
        self.binary = Path(binary).resolve(strict=True)
        if digest(self.binary.read_bytes()) != "895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9":
            raise ValueError("binary does not match the reviewed official 0.14.3 Linux release")
        self.output = Path(output).resolve()
        self.output.mkdir(mode=0o700, parents=True, exist_ok=False)
        # 放在 /workspace 下，避免把普通 /tmp 子目录误当官方长路径别名规则。
        self.root = Path(tempfile.mkdtemp(prefix=".luvus-p0-", dir="/workspace"))
        for name in ("state", "child-home", "project", "runtime"):
            (self.root / name).mkdir(mode=0o700)
        self.session = "p0-issue3"
        # 子进程只接收本次构造的环境；不复制调用者环境、凭据或会话选择器。
        self.environment = {
            "PATH": "/usr/bin:/bin", "HOME": str(self.root / "child-home"),
            "XDG_CONFIG_HOME": str(self.root / "child-home" / "config"),
            "XDG_DATA_HOME": str(self.root / "child-home" / "data"),
            "XDG_CACHE_HOME": str(self.root / "child-home" / "cache"),
            "XDG_RUNTIME_DIR": str(self.root / "runtime"),
            "LUVUS_HOME": str(self.root / "state"), "SHELL": "/bin/sh",
            "TERM": "xterm-256color", "LANG": "C.UTF-8",
        }
        self.records = []
        self.checks = []
        self.streams = []
        self.server = None
        self.endpoint = None
        self.endpoint_identity = None
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.completed = False
        self.collection_failure = None

    # 仅替换本次临时根目录和二进制绝对路径，保留其他证据文本。
    def safe_text(self, value):
        return value.replace(str(self.root), "/fixture/issue3").replace(str(self.binary), "/fixture/bin/luvus")

    # 将对象序列化为 JSON，经路径脱敏后写入证据目录。
    def save(self, name, value):
        text = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        (self.output / name).write_text(self.safe_text(text))

    # 登记断言真假，并在失败时立即中止当前采集步骤。
    def check(self, label, condition):
        self.checks.append({"assertion": label, "passed": bool(condition)})
        if not condition:
            raise AssertionError(label)

    # 运行隔离原生命令，超时终止或强杀子进程，并记录输入输出与原始字节摘要。
    def run(self, label, arguments, request=None, timeout=10, raw_input=None):
        wire = raw_input if raw_input is not None else (
            json.dumps(request, separators=(",", ":")) + "\n" if request is not None else "")
        args = [str(self.binary), "--session", self.session, *arguments]
        start = time.monotonic()
        process = subprocess.Popen(args, env=self.environment, cwd=self.root / "project",
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        timed_out = False
        try:
            stdout, stderr = process.communicate(wire.encode(), timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate(timeout=3)
        record = {"label": label, "kind": "process", "argv": args, "stdin": wire,
                  "stdout": stdout.decode(), "stderr": stderr.decode(), "exit_code": process.returncode,
                  "timed_out": timed_out, "elapsed_ms": round((time.monotonic() - start) * 1000),
                  "raw_stdout_sha256": digest(stdout), "raw_stderr_sha256": digest(stderr)}
        self.records.append(record)
        return record

    # 通过原生 stdio 代理发出单次请求，返回解析后的响应对象。
    def proxy(self, label, method, params=None, **kwargs):
        record = self.run(label, ["uhp", "proxy"],
                          {"id": label, "method": method, "params": params or {}}, **kwargs)
        return json.loads(record["stdout"])

    # 调用会话列表 CLI，确认成功退出后解析发现结果。
    def discover(self, label):
        result = self.run(label, ["session", "list", "--json"])
        self.check(label + ": exit 0", result["exit_code"] == 0)
        return json.loads(result["stdout"])

    # 核对新建 Unix socket 的路径、所有权和权限，并防止连接前身份被替换。
    def validate_endpoint(self):
        address = Path(self.endpoint["address"])
        self.check("endpoint transport is unix_socket", self.endpoint["transport"] == "unix_socket")
        self.check("endpoint is absolute and in new state root", address.is_absolute() and address.is_relative_to(self.root / "state"))
        details = []
        for path in [*reversed(address.parents), address]:
            info = path.lstat()
            self.check("endpoint component has no symlink: " + str(path), not stat.S_ISLNK(info.st_mode))
            if path != address:
                self.check("endpoint parent is directory: " + str(path), stat.S_ISDIR(info.st_mode))
                self.check("endpoint ancestor is not group/world writable: " + str(path), info.st_mode & 0o022 == 0)
            if path.is_relative_to(self.root):
                self.check("private endpoint component belongs to current uid: " + str(path), info.st_uid == os.geteuid())
                self.check("private endpoint component mode: " + str(path), stat.S_IMODE(info.st_mode) == (0o600 if path == address else 0o700))
            details.append({"path": str(path), "uid": info.st_uid, "mode": oct(stat.S_IMODE(info.st_mode))})
        info = address.lstat()
        self.check("endpoint is socket and canonical", stat.S_ISSOCK(info.st_mode) and address.resolve() == address)
        identity = [info.st_dev, info.st_ino, info.st_ctime_ns]
        if self.endpoint_identity is not None:
            self.check("endpoint device/inode/ctime unchanged before connect", identity == self.endpoint_identity)
        self.endpoint_identity = identity
        self.records.append({"kind": "endpoint_validation", "components": details, "identity": identity})
        return str(address)

    # 复核端点后建立已登记的连接，并发送流握手或普通 RPC 请求。
    def stream(self, label, method, params=None):
        address = self.validate_endpoint()
        stream = Wire(self, label, address)
        self.streams.append(stream)
        stream.send({"id": label, "method": method, "params": params or {}})
        return stream

    # 在单独连接上发送请求、读取一次响应后关闭连接并返回响应。
    def rpc(self, label, method, params=None):
        stream = self.stream(label, method, params)
        response = stream.receive()
        stream.close()
        return response

    # 采集 schema、能力和请求边界证据，启动本次服务器并继续验证原生流行为。
    def collect(self):
        version = self.run("binary-version", ["--version"])
        self.check("binary version is 0.14.3", version["stdout"] == "luvus 0.14.3\n")
        before = self.discover("discovery-before-host")
        self.check("no running sessions before Host", not any(row["running"] for row in before["sessions"]))
        bundle = self.run("installed-schema", ["uhp", "schema"])
        self.check("schema available without server", bundle["exit_code"] == 0)
        (self.output / "schema-bundle.json").write_text(bundle["stdout"])
        # bundle 单独保存，记录精确原文校验值，避免重复大段数据。
        bundle["stdout_file"] = "schema-bundle.json"
        bundle.pop("stdout")
        host = self.proxy("host-capabilities-before-server", "host.capabilities")
        self.save("host-capabilities.json", host)
        self.proxy("host-info-before-server", "host.info")
        self.proxy("host-session-list-before-server", "session.list")
        after = self.discover("discovery-after-host")
        self.check("Host reads do not start session", not any(row["running"] for row in after["sessions"]))
        missing = self.run("session-rpc-before-server", ["uhp", "proxy"],
                           {"id": "session-rpc-before-server", "method": "ping", "params": {}})
        self.check("offline session RPC is process failure without fabricated response", missing["exit_code"] != 0 and missing["stdout"] == "")
        self.server_out = open(self.root / "server.stdout", "wb")
        self.server_err = open(self.root / "server.stderr", "wb")
        args = [str(self.binary), "--session", self.session, "server"]
        self.server = subprocess.Popen(args, env=self.environment, cwd=self.root / "project",
                                       stdin=subprocess.DEVNULL, stdout=self.server_out, stderr=self.server_err)
        self.records.append({"kind": "server_start", "argv": args, "pid": self.server.pid})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            rows = self.discover("discovery-startup")["sessions"]
            running = [row for row in rows if row["running"] and row["name"] == self.session]
            if running:
                self.check("exactly one owned named session", len(running) == 1)
                self.endpoint = running[0]["endpoint"]
                break
            self.check("server remains alive during startup", self.server.poll() is None)
            time.sleep(0.05)
        self.check("running endpoint discovered from CLI", self.endpoint is not None)
        self.run("server-status", ["server", "status"])
        capabilities = self.proxy("session-capabilities", "uhp.capabilities")
        self.save("session-capabilities.json", capabilities)
        self.check("UHP negotiated 1.0", capabilities["result"]["protocol"] == {"name": "luvus-uhp", "major": 1, "minor": 0})
        ping = self.stream("direct-ping", "ping")
        self.check("server ping version matches binary", ping.receive()["result"]["version"] == "0.14.3")
        self.check("ordinary connection ends after one LF response", ping.receive() is None)
        ping.close()
        ordinary = self.run("proxy-ping", ["uhp", "proxy"], {"id": "proxy-ping", "method": "ping", "params": {}})
        self.check("proxy success stdout is one LF JSON response", ordinary["exit_code"] == 0 and ordinary["stdout"].endswith("\n") and len(ordinary["stdout"].splitlines()) == 1 and ordinary["stderr"] == "")
        two = self.run("proxy-two-requests", ["uhp", "proxy"], raw_input='{"id":"first","method":"ping","params":{}}\n{"id":"second","method":"ping","params":{}}\n')
        self.check("proxy handles only first input frame", json.loads(two["stdout"])["id"] == "first" and len(two["stdout"].splitlines()) == 1)
        no_lf = self.run("proxy-no-final-lf", ["uhp", "proxy"], raw_input='{"id":"no-lf","method":"ping","params":{}}')
        self.check("missing LF rejected before response", no_lf["exit_code"] == 1 and no_lf["stdout"] == "" and "missing LF" in no_lf["stderr"])
        malformed = self.run("proxy-malformed-json", ["uhp", "proxy"], raw_input='{\n')
        self.check("invalid JSON is process failure", malformed["exit_code"] == 1 and malformed["stdout"] == "")
        error = self.run("proxy-unknown-method", ["uhp", "proxy"], {"id": "proxy-unknown-method", "method": "p0.unknown", "params": {}})
        self.check("native error retains id and nonzero exit", error["exit_code"] == 1 and json.loads(error["stdout"])["id"] == "proxy-unknown-method" and "error" in json.loads(error["stdout"]))
        self.collect_streams()

    # 用自建终端验证订阅顺序、观察、控制租约、输入和关闭行为，并记录断言。
    def collect_streams(self):
        events = self.stream("events-primary", "events.subscribe")
        events_ack = events.receive()
        self.check("events stream acknowledged", events_ack["result"]["type"] == "subscription_started")
        other = self.stream("events-independent", "events.subscribe")
        self.check("independent event subscriber acknowledged", other.receive()["result"]["type"] == "subscription_started")
        initial = self.rpc("snapshot-before-create", "session.snapshot")["result"]
        # 使用只处理固定测试文本的自建进程；输出反转文本证明实际消费，而非终端回显。
        created = self.rpc("terminal-create", "terminal.backend.create", {
            "cwd": str(self.root / "project"), "command": ["/usr/bin/python3", "-u", "-c",
                "import sys\nfor line in sys.stdin: print('CONSUMED:' + line.rstrip('\\n')[::-1], flush=True)"],
            "label": "issue3-synthetic-terminal", "placement": {"kind": "workspace"}, "focus": False, "restore": False,
        })["result"]
        self.check("own terminal created without focus or restore", created["dispatch"] == "executed" and created["restore"] is False)
        identity = {key: created[key] for key in ("server_generation", "terminal_id", "pane_id")}
        self.save("terminal-identity.json", identity)
        created_event = events.until(lambda x: x.get("event") == "terminal.created" and x.get("data", {}).get("terminal_id") == identity["terminal_id"])  # 谓词仅接纳本次终端的创建事件，确定主订阅的序列围栏。
        other_event = other.until(lambda x: x.get("event") == "terminal.created" and x.get("data", {}).get("terminal_id") == identity["terminal_id"])  # 谓词从独立订阅筛选同一终端创建事件，供双订阅一致性比对。
        snapshot = self.rpc("snapshot-after-create", "session.snapshot")["result"]
        self.check("subscribe snapshot sequence fence", initial["event_sequence"] < created_event["sequence"] <= snapshot["event_sequence"])
        self.check("two subscribers receive same native sequence", created_event == other_event)
        self.check("snapshot contains created terminal", any(p.get("terminal_id") == identity["terminal_id"] for w in snapshot["workspaces"] for t in w["tabs"] for p in t["panes"]))
        inventory = self.rpc("terminal-inventory", "terminal.backend.inventory")["result"]
        self.save("terminal-inventory.json", inventory)
        observed = self.stream("terminal-observe", "terminal.backend.observe", dict(identity, mode="visible", lines=24, ansi=False))
        observe_ack = observed.receive()
        self.check("observe acknowledged", "result" in observe_ack)
        observed.until(lambda x: x.get("event") == "terminal.frame")  # 谓词等待观察流的首个终端帧，确认握手后能收到画面。
        stale = self.rpc("control-stale-generation", "terminal.backend.control", dict(identity, server_generation="0" * 32))
        self.check("stale generation control is refused", "error" in stale)
        wrong = self.rpc("control-wrong-terminal", "terminal.backend.control", dict(identity, terminal_id="0" * 32))
        self.check("wrong terminal lifetime is refused", "error" in wrong)
        other_pane = next(p["pane_id"] for w in initial["workspaces"] for t in w["tabs"] for p in t["panes"] if p.get("terminal_id") != identity["terminal_id"])
        wrong_route = self.rpc("control-wrong-pane", "terminal.backend.control", dict(identity, pane_id=other_pane))
        self.check("wrong pane route is fenced", wrong_route["error"]["code"] == "stale_route")
        control = self.stream("terminal-control", "terminal.backend.control", dict(identity, mode="visible", lines=24, ansi=False))
        control_ack = control.receive()
        self.check("control acknowledged", "result" in control_ack)
        control.until(lambda x: x.get("event") == "terminal.frame")  # 谓词等待控制流的首个终端帧，确认控制握手成功。
        second = self.rpc("control-lease-conflict", "terminal.backend.control", identity)
        self.check("second control lease refused", "error" in second)
        control.send({"id": "input-1", "action": "submit_text", "params": {"text": "p0-input-abc123"}})
        ack = control.until(lambda x: x.get("id") == "input-1")  # 谓词按请求标识匹配输入确认，排除交错的终端事件。
        self.check("input ack is correlated and queued", ack["result"]["dispatch"] == "queued")
        frame = observed.until(lambda x: x.get("event") == "terminal.frame" and "CONSUMED:321cba-tupni-0p" in json.dumps(x))  # 谓词等待含子进程反转输出的画面，证明测试输入确被消费。
        self.check("child transformed input observed independently", "CONSUMED:321cba-tupni-0p" in json.dumps(frame))
        control.send({"id": "input-invalid", "action": "not_a_native_action", "params": {}})
        invalid = control.until(lambda x: x.get("id") == "input-invalid")  # 谓词按请求标识筛选非法控制动作的原生拒绝响应。
        self.check("unknown control action refused", "error" in invalid)
        control.close()
        # 仅为验证异步租约释放而重试 control 握手；这需要控制权限，不重发输入。
        reacquired = None
        for index in range(20):
            candidate = self.stream("control-reacquire-" + str(index), "terminal.backend.control", identity)
            response = candidate.receive()
            if "result" in response:
                reacquired = candidate
                break
            candidate.close()
            time.sleep(0.025)
        self.check("control disconnect releases native lease", reacquired is not None)
        reacquired.close()
        self.check("closing streams preserves pane", self.rpc("validate-after-stream-close", "terminal.backend.validate", identity)["result"]["state"] == "alive")
        native_timeout = self.proxy("native-wait-timeout", "terminal.backend.wait_output", dict(identity, after_revision=0, match="never-produced-p0-marker", timeout_ms=30))
        self.check("native timeout remains original UHP error", native_timeout["error"]["code"] == "timeout")
        timed = self.run("client-deadline", ["uhp", "proxy"], {"id": "client-deadline", "method": "terminal.backend.wait_output", "params": dict(identity, after_revision=0, match="never-produced-p0-marker", timeout_ms=5000)}, timeout=0.05)
        self.check("bridge deadline terminates child process", timed["timed_out"] and timed["exit_code"] != 0)
        self.check("bridge cancellation did not close terminal", self.rpc("validate-after-deadline", "terminal.backend.validate", identity)["result"]["state"] == "alive")
        closed = self.rpc("terminal-close", "terminal.backend.close", identity)
        self.check("explicit terminal close executed", closed["result"]["dispatch"] == "executed")
        close_event = events.until(lambda x: x.get("event") == "terminal.closed" and x.get("data", {}).get("terminal_id") == identity["terminal_id"])  # 谓词筛选本次终端的关闭事件，验证其发生在快照围栏之后。
        self.check("close event follows snapshot fence", close_event["sequence"] > snapshot["event_sequence"])
        replay = self.stream("events-replay", "events.subscribe", {"after_sequence": snapshot["event_sequence"]})
        self.check("replay subscription acknowledged", "result" in replay.receive())
        replayed_close = replay.until(lambda x: x.get("event") == "terminal.closed" and x.get("data", {}).get("terminal_id") == identity["terminal_id"])  # 谓词筛选重放中的同一终端关闭事件，供原生序列回放比对。
        self.check("after_sequence replays same native event", replayed_close == close_event)
        self.check("closed terminal is gone", self.rpc("validate-after-terminal-close", "terminal.backend.validate", identity)["result"]["state"] == "gone")
        stale_input = self.rpc("input-after-close", "terminal.backend.type_literal", dict(identity, text="must-not-send"))
        self.check("closed terminal rejects input", "error" in stale_input)
        self.check("observed terminal stream terminates after close", observed.until(lambda x: x.get("event") == "terminal.closed") is not None)  # 谓词等待观察流的终端关闭事件，之后再核对 EOF。
        self.check("observe EOF after terminal close", observed.receive() is None)

    # 关闭已登记资源，停止自建服务器并清理私有目录，保存证据及清理失败详情。
    def finish(self):
        cleanup_errors = []

        # 累计清理阶段的异常类型与消息，使后续清理仍能继续。
        def failed(stage, error):
            cleanup_errors.append({"stage": stage, "error": type(error).__name__, "message": str(error)})

        for stream in self.streams:
            try:
                stream.close()
            except Exception as error:
                failed("stream_close", error)
        no_running = None
        if self.server is not None:
            try:
                if self.server.poll() is None:
                    self.server.terminate()
                    try:
                        self.server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.server.kill()
                        self.server.wait(timeout=3)
            except Exception as error:
                failed("server_stop", error)
            try:
                self.server_out.close()
                self.server_err.close()
                self.records.append({"kind": "server_exit", "exit_code": self.server.returncode,
                                     "stdout": (self.root / "server.stdout").read_text(),
                                     "stderr": (self.root / "server.stderr").read_text()})
            except Exception as error:
                failed("server_log", error)
            try:
                rows = self.discover("discovery-after-cleanup")["sessions"]
                no_running = not any(row["running"] for row in rows)
                self.check("no running sessions after cleanup", no_running)
            except Exception as error:
                failed("cleanup_discovery", error)
        # 发现/日志/写证据的异常不能跳过私有目录清理；只有实际删除后才登记成功。
        server_stopped = self.server is None or self.server.poll() is not None
        if server_stopped:
            try:
                shutil.rmtree(self.root)
            except Exception as error:
                failed("root_remove", error)
        else:
            failed("root_remove", RuntimeError("owned server still alive; preserve its state for manual cleanup"))
        cleanup = {"server_stopped": server_stopped, "no_running_sessions": no_running,
                   "temporary_root_removed": not self.root.exists(), "errors": cleanup_errors}
        self.records.append({"kind": "cleanup", **cleanup})
        if self.collection_failure is not None:
            self.records.append({"kind": "collection_failure", **self.collection_failure})
        if cleanup_errors:
            self.completed = False
        self.save("transcript.json", self.records)
        self.save("assertions.json", self.checks)
        self.save("environment.json", {"binary_sha256": digest(self.binary.read_bytes()),
                  "platform": platform.platform(), "uid": os.geteuid(), "session": self.session,
                  "started_at": self.started_at, "native_collection_completed": self.completed,
                  "os_release": Path("/etc/os-release").read_text(),
                  "python_version": platform.python_version(),
                  "child_environment": self.environment, "base_commit": "916cae2412b69f3432caf264fd411ea1a4b3093f",
                  "cleanup": cleanup})
        self.save("manifest.json", {"format": 1, "kind": "sanitized-native-evidence", "files": {
            path.name: {"sha256": digest(path.read_bytes()), "bytes": path.stat().st_size}
            for path in sorted(self.output.iterdir()) if path.name != "manifest.json"
        }, "redaction": "Only run root and binary path replaced. Generated identities, sequence, errors, LF and payloads retained. Raw CLI stdout/stderr hashes are pre-normalization; manifest hashes cover delivered bytes."})
        if cleanup_errors:
            raise RuntimeError("cleanup checks failed: " + ", ".join(error["stage"] for error in cleanup_errors))


class Wire:
    # 连接 Unix socket 并验证 Linux 对端身份与本次服务器一致，失败时关闭连接。
    def __init__(self, capture, label, address):
        self.capture, self.label, self.buffer = capture, label, b""
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(5)
        try:
            self.socket.connect(address)
            pid, uid, gid = struct.unpack("3i", self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            capture.check("Linux peer uid and server pid match", uid == os.geteuid() and pid == capture.server.pid)
        except Exception:
            self.socket.close()
            raise
        capture.records.append({"kind": "peer_credentials", "channel": label, "pid": pid, "uid": uid, "gid": gid})

    # 把对象编码为单行 JSON 发送，并保存对应传输原文记录。
    def send(self, value):
        wire = json.dumps(value, separators=(",", ":")) + "\n"
        self.capture.records.append({"kind": "send", "channel": self.label, "wire": wire})
        self.socket.sendall(wire.encode())

    # 在超时和缓冲区限制内读取一帧 JSON 并记录原文；仅帧边界上的 EOF 返回空值。
    def receive(self, timeout=5):
        deadline = time.monotonic() + timeout
        while b"\n" not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.socket], [], [], max(remaining, 0))[0]:
                raise TimeoutError(self.label)
            data = self.socket.recv(65536)
            if not data:
                if self.buffer:
                    raise ValueError("truncated frame at EOF")
                self.capture.records.append({"kind": "eof", "channel": self.label})
                return None
            self.buffer += data
            if len(self.buffer) > 2 * 1024 * 1024:
                raise ValueError("bounded stream buffer exceeded")
        wire, self.buffer = self.buffer.split(b"\n", 1)
        self.capture.records.append({"kind": "receive", "channel": self.label, "wire": wire.decode() + "\n"})
        return json.loads(wire)

    # 持续读取并跳过不匹配帧，返回首个满足谓词的帧或报告超时、EOF。
    def until(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self.receive(max(0.001, deadline - time.monotonic()))
            if value is None:
                raise EOFError(self.label)
            if predicate(value):
                return value
        raise TimeoutError(self.label)

    # 关闭尚未关闭的 socket，并登记客户端断开记录。
    def close(self):
        if self.socket.fileno() >= 0:
            self.socket.close()
            self.capture.records.append({"kind": "client_close", "channel": self.label})


# 读取采集参数，运行独立采集并确保成功或异常后都执行收尾清理。
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--output", required=True, help="必须是尚不存在的证据目录")
    args = parser.parse_args()
    capture = Capture(args.binary, args.output)
    try:
        capture.collect()
        capture.completed = True
    except BaseException as error:
        capture.collection_failure = {"error": type(error).__name__, "message": str(error)}
        raise
    finally:
        capture.finish()


if __name__ == "__main__":
    main()
