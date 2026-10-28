FROM node:22-alpine

# curl is used by the container healthcheck below
RUN apk add --no-cache curl tini su-exec

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY public ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/data && addgroup -S app && adduser -S app -G app && chown -R app:app /app
# Stays root only long enough for the entrypoint to chown the volume.

ENV NODE_ENV=production PORT=8080 DB_PATH=/app/data/opencam.db
EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=8s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
