# #324 — e2e test image. better-sqlite3 is a NATIVE module compiled for the
# container's node ABI, so we `npm ci` INSIDE the image (the host node_modules
# can't be reused across ABIs). The source is bind-mounted at run time (see
# docker-compose.yml) for live iteration; an anonymous volume preserves this
# image's compiled node_modules over the bind mount.
# #3240 — the session host and the PTY proxy, built for THIS image, so the unit
# suites that drive a real `cl-session-host` run here instead of skipping (the
# checkout's own target/ was built on the host, whose libc this image may not
# have). Same stage as tests/Dockerfile.agent; `build.rs` reads the version from
# package.json, hence the copy.
FROM rust:1-slim-bookworm AS proxy
WORKDIR /build
COPY package.json ./package.json
COPY windows/cl-pty-proxy ./windows/cl-pty-proxy
RUN cargo build --release --locked --manifest-path windows/cl-pty-proxy/Cargo.toml

FROM node:22-slim
WORKDIR /app

# build toolchain for the better-sqlite3 native compile, plus tmux: a few unit
# tests shell out to it, and git: the commit-credit tests build throwaway repos
# (the `tests` service runs the unit suite in this image)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ tmux procps git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=proxy /build/windows/cl-pty-proxy/target/release/cl-session-host /opt/cl-pty-proxy/cl-session-host
COPY --from=proxy /build/windows/cl-pty-proxy/target/release/cl-pty-proxy /opt/cl-pty-proxy/cl-pty-proxy
ENV CL_SESSION_HOST_BIN=/opt/cl-pty-proxy/cl-session-host
ENV CL_PROXY_BIN=/opt/cl-pty-proxy/cl-pty-proxy

COPY package.json package-lock.json ./
RUN npm ci

# #3240 — the frontend's dependencies too: its unit tests run here (one of them
# drives the real daemon, so they need the root's packages as well).
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

# source is mounted as a volume at runtime; default = run the real daemon
CMD ["npx", "tsx", "src/daemon.ts"]
