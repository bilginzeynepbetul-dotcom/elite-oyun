FROM node:20-alpine

# Güvenlik: gereksiz paket yok; non-root kullanıcı
RUN addgroup -g 1001 -S elite && adduser -S elite -u 1001 -G elite

WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      echo "UYARI: package-lock.json yok — reproducible build icin 'npm install' calistirip commit edin." && \
      npm install --omit=dev; \
    fi \
    && npm cache clean --force

COPY . .

# Yazılabilir dizinler (log / yedek) — non-root için
RUN mkdir -p /app/logs /app/backups \
    && chown -R elite:elite /app

ENV NODE_ENV=production
ENV PORT=3000

USER elite
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# npm start migrate+server; non-root ile çalışır
CMD ["npm", "start"]
