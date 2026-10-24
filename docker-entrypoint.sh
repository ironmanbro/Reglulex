#!/bin/sh
set -e
case "$1" in
  web)
    node_modules/.bin/tsx scripts/seed.ts   # applies migrations, then idempotent seed
    exec node_modules/.bin/next start -p "${PORT:-3000}" ;;
  worker)
    exec node_modules/.bin/tsx scripts/worker.ts ;;
  worker-once)
    exec node_modules/.bin/tsx scripts/worker.ts --once ;;
  migrate)
    exec node_modules/.bin/tsx scripts/migrate.ts ;;
  crawl)
    shift; exec node_modules/.bin/tsx scripts/crawl.ts "$@" ;;
  *)
    exec "$@" ;;
esac
