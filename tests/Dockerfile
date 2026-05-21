# #324 — e2e test image. better-sqlite3 is a NATIVE module compiled for the
# container's node ABI, so we `npm ci` INSIDE the image (the host node_modules
# can't be reused across ABIs). The source is bind-mounted at run time (see
# docker-compose.yml) for live iteration; an anonymous volume preserves this
# image's compiled node_modules over the bind mount.
FROM node:22-slim
WORKDIR /app

# build toolchain for the better-sqlite3 native compile
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# source is mounted as a volume at runtime; default = run the real daemon
CMD ["npx", "tsx", "src/daemon.ts"]
