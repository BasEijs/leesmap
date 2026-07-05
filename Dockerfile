FROM node:22-slim

WORKDIR /app

# Install production dependencies from the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Persisted settings (device IP, saved feeds) live here.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

# De Correspondent sends huge response headers (a ~14 KB Link: preload list),
# which overflow Node's default 16 KB HTTP header limit and make fetch() throw
# "Header overflow". Raise the limit so article/feed fetches parse.
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-http-header-size=65536

EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
