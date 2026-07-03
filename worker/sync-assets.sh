#!/usr/bin/env sh
# 把根目录 index.html 同步到 worker/assets/（部署前必须一致）
# 用法：./worker/sync-assets.sh
set -e
cd "$(dirname "$0")"

src="../index.html"
dst="assets/index.html"

if [ ! -f "$src" ]; then
  echo "error: missing $src" >&2
  exit 1
fi

mkdir -p assets
cp "$src" "$dst"

if ! cmp -s "$src" "$dst"; then
  echo "error: sync failed — $dst still differs from $src" >&2
  exit 1
fi

echo "synced $src → $dst"
