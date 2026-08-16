FROM node:20-alpine

# Güvenlik: non-root kullanıcı + yedek için pg_dump
RUN addgroup -g 1001 -S elite && adduser -S elite -u 1001 -G elite \
    && apk add --no-cache postgresql16-client gzip \
    || apk add --no-cache postgresql-client gzip

WORKDIR /app

# package-lock.json zorunlu — reproducible build (npm ci)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY . .

RUN mkdir -p /app/logs /app/backups \
    && chown -R elite:elite /app

ENV NODE_ENV=production
ENV PORT=3000

USER elite
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["npm", "start"]
