#!/bin/sh
# 仅安装官方 latest 稳定发行；单次解析 tag 后固定下载，不创建身份、服务或修改用户 PATH。
set -eu

install_dir=${HOME:?HOME is required}/.local/bin
print_asset=false
stage=''

# 所有失败均在原子替换前退出；只回收本次创建的私有暂存目录。
cleanup() {
  if [ -n "$stage" ]; then rm -rf -- "$stage"; fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

fail() { printf '%s\n' "$1" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: sh install.sh [--install-dir /absolute/path] [--print-asset]' \
    'Installs the latest stable ArnoChenFx/rovloom release to ~/.local/bin.' \
    'Requires curl and sha256sum (Linux) or shasum (macOS). Linux needs glibc or musl.' \
    'Installing a binary does not establish Gateway/Connector platform support.'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)
      [ "$#" -ge 2 ] || fail 'Missing option value.'
      install_dir=$2
      shift 2 ;;
    --print-asset) print_asset=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail 'Unknown option.' ;;
  esac
done
case "$install_dir" in /*) ;; *) fail 'Install directory must be absolute.';; esac
libc=''
case "$(uname -s)" in
  Linux)
    os=linux
    # 只有 getconf 的 glibc 版本行能正面证明 glibc；其它 Linux（含 getconf 缺失的 Alpine）按 musl 选择。
    if getconf GNU_LIBC_VERSION 2>/dev/null | LC_ALL=C grep -Eq '^glibc [0-9]+\.[0-9]+'; then
      libc=glibc
    else
      libc=musl
    fi ;;
  Darwin) os=darwin ;;
  *) fail 'Unsupported operating system. Windows requires install.ps1.' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) fail 'Unsupported architecture; expected x64 or arm64.' ;;
esac
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
[ ! -L "$install_dir" ] || fail 'Install directory must not be a symbolic link.'
destination=$install_dir/rovloom
[ ! -L "$destination" ] || fail 'Existing program must not be a symbolic link.'
if [ -e "$destination" ] && [ ! -f "$destination" ]; then fail 'Existing program is not a regular file.'; fi
# latest 只解析一次；只接受官方规范稳定 tag，后续摘要和二进制均绑定这个版本。
latest_url=$(curl --head --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 120 --output /dev/null --write-out '%{url_effective}' \
  https://github.com/ArnoChenFx/rovloom/releases/latest) \
  || fail 'Latest release is unavailable; existing program was kept.'
case "$latest_url" in
  https://github.com/ArnoChenFx/rovloom/releases/tag/v*)
    version=${latest_url#https://github.com/ArnoChenFx/rovloom/releases/tag/v} ;;
  *) fail 'Latest release did not resolve to an official tag; existing program was kept.' ;;
esac
case "$version" in *[!0-9.]*) fail 'Latest release must resolve to a canonical stable version; existing program was kept.';; esac
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$' \
  || fail 'Latest release must resolve to a canonical stable version; existing program was kept.'
asset=rovloom-$version-$os-$arch
if [ "$libc" = musl ]; then asset=$asset-musl; fi
if [ "$print_asset" = true ]; then printf '%s\n' "$asset"; exit 0; fi
if command -v sha256sum >/dev/null 2>&1; then
  hash_program=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hash_program=shasum
else
  fail 'sha256sum or shasum is required.'
fi
mkdir -p -- "$install_dir"
[ -d "$install_dir" ] || fail 'Install directory is not a directory.'
stage=$(mktemp -d "$install_dir/.rovloom-install.XXXXXXXX")
chmod 700 "$stage"
base=https://github.com/ArnoChenFx/rovloom/releases/download/v$version
# 强制 HTTPS，拒绝 HTTP 失败并限制时间和大小；没有第三方镜像或自定义下载来源。
download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 120 --max-filesize "$3" --output "$2" "$base/$1"
}
download SHA256SUMS "$stage/SHA256SUMS" 65536 || fail 'Release checksums are unavailable; existing program was kept.'
expected=$(LC_ALL=C awk -v name="$asset" '
  $2 == name {
    count++
    if (NF != 2 || length($1) != 64 || $1 !~ /^[a-f0-9]+$/ || $0 != $1 "  " name) bad=1
    digest=$1
  }
  END { if (count != 1 || bad) exit 1; print digest }
' "$stage/SHA256SUMS") || fail 'Missing or ambiguous asset checksum; existing program was kept.'
download "$asset" "$stage/rovloom" 268435456 || fail 'Release binary is unavailable; existing program was kept.'
[ -s "$stage/rovloom" ] || fail 'Release binary is empty; existing program was kept.'
if [ "$hash_program" = sha256sum ]; then
  actual=$(sha256sum "$stage/rovloom" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$stage/rovloom" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || fail 'Release checksum mismatch; existing program was kept.'
chmod 755 "$stage/rovloom"
# 同目录暂存使 rename 保持同文件系统原子提交；失败不先删除旧程序。
mv -f -- "$stage/rovloom" "$destination" || fail 'Unable to replace program; existing program was kept.'
printf 'Installed Rovloom %s at %s\n' "$version" "$destination"
printf '%s\n' 'Run the full path with --help. Add its directory to PATH if desired.' \
  'This installs the binary only; role configuration and platform runtime acceptance are separate.'
if [ "$libc" = musl ]; then
  printf '%s\n' 'This is the musl build: it needs libstdc++ (Alpine: apk add libstdc++).' \
    'Luvus managed native process control is unavailable on musl; Gateway, Herdr and Luvus attach work.'
fi
