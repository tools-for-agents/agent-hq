# Agent HQ — zero runtime dependencies, so the image is tiny and the build never breaks.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY mcp ./mcp

ENV PORT=7700
ENV HQ_DB_PATH=/app/data/agenthq.db
VOLUME /app/data
EXPOSE 7700

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:7700/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
