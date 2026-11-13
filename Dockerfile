FROM oven/bun:1.4.4

# LibreOffice (headless) converts uploaded DOCX documents to PDF before signing.
# The Writer component alone is far smaller than the full suite, and the
# Liberation fonts give the conversion metric-compatible typography so a
# converted document keeps its layout. Installed before the app is copied so the
# layer is cached across code changes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "src/server.ts"]
