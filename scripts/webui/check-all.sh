#!/usr/bin/env bash
# 依次运行全部 WebUI 浏览器检查（需先 bun run build，且有 Python Playwright 与 Chromium）。
# 用法：scripts/webui/check-all.sh [输出目录，默认 mktemp]；CHROMIUM_PATH 可指定 Chromium，缺省使用 Playwright 自带的浏览器。
set -u
cd "$(dirname "$0")/../.."
out="${1:-$(mktemp -d)}"
mkdir -p "$out"
bun --no-env-file scripts/webui/preview.mjs 33230 > "$out/preview-read.log" 2>&1 &
reader=$!
bun --no-env-file scripts/webui/preview.mjs 33231 --actions > "$out/preview-actions.log" 2>&1 &
actions=$!
trap 'kill $reader $actions 2>/dev/null' EXIT
for _ in $(seq 1 50); do
  grep -q "UI verification" "$out/preview-read.log" 2>/dev/null && grep -q "UI verification" "$out/preview-actions.log" 2>/dev/null && break
  sleep 0.2
done
status=0
for entry in browser:33230 preferences:33230 layout:33230 actions:33231 lifecycle:33231 bootstrap:33231 retry-deadline:33231 lan:33231 dashboard:33230 resources:33231; do
  name="${entry%%:*}"
  port="${entry##*:}"
  args=("scripts/webui/check-$name.py" --url "http://127.0.0.1:$port" --output "$out/$name")
  if [[ "$name" == dashboard ]]; then args+=(--actions-url http://127.0.0.1:33231); fi
  if python3 "${args[@]}" > "$out/$name.log" 2>&1; then
    echo "ok   $name"
  else
    echo "FAIL $name"
    tail -20 "$out/$name.log"
    status=1
  fi
done
exit $status
