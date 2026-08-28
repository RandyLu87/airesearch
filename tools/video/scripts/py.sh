#!/usr/bin/env bash
# npm run tts / tts:batch 的运行入口：优先用 uv 拉起隔离环境（无需预装依赖），
# 否则回退到当前 python3（要求已 pip install -r scripts/requirements.txt）。
# 用法：scripts/py.sh <脚本名> [参数...]，脚本名相对 scripts/。
set -euo pipefail
cd "$(dirname "$0")/.."

script="scripts/$1"
shift

if command -v uv >/dev/null 2>&1; then
  exec uv run --quiet --with-requirements scripts/requirements.txt python "$script" "$@"
fi

if ! python3 -c 'import edge_tts' >/dev/null 2>&1; then
  echo "缺少 edge-tts：请安装 uv，或执行 pip install -r scripts/requirements.txt" >&2
  exit 1
fi

exec python3 "$script" "$@"
