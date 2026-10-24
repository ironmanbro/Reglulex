# One image, two processes:
#   web:    docker run ... image web      (migrates, seeds registry, serves Next.js on $PORT)
#   worker: docker run ... image worker   (scheduler + job queue: crawling, downloads, OCR)
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build && pnpm prune --prod

FROM base AS runtime
# poppler-utils: pdftotext/pdftoppm. tesseract-ocr: OCR for scanned PDFs (English + Hindi).
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=build /app/tsconfig.json ./
COPY docker-entrypoint.sh /usr/local/bin/entrypoint
# data/storage: original files when STORAGE_DRIVER=local (mount a volume here).
RUN chmod +x /usr/local/bin/entrypoint && useradd -r -u 10001 app && mkdir -p /app/data/storage && chown -R app /app
USER app
EXPOSE 3000
ENTRYPOINT ["tini", "--", "entrypoint"]
CMD ["web"]
