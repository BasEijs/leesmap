FROM node:22-slim

WORKDIR /app

# Install production dependencies from the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Persisted settings (device IP, saved feeds) live here.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
