#!/usr/bin/env sh
# 一键部署：同步前端到 assets → wrangler deploy
# 用法：./worker/deploy.sh  或  cd worker && ./deploy.sh
set -e
cd "$(dirname "$0")"
./sync-assets.sh
npx wrangler deploy
