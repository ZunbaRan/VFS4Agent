FROM node:22-bookworm

# FUSE 2 runtime + headers for native build of fuse-native.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fuse \
    libfuse2 \
    libfuse-dev \
    build-essential \
    python3 \
    ca-certificates \
    tree \
    && rm -rf /var/lib/apt/lists/*

# Allow non-root processes to mount FUSE with allow_other.
RUN echo "user_allow_other" >> /etc/fuse.conf

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile
RUN pnpm approve-builds fuse-native better-sqlite3 || true

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

RUN mkdir -p /vfs /app/data

ENV VFS_MOUNT=/vfs \
    VFS_BACKEND=sqlite \
    VFS_DB_PATH=/app/data/vfs.db

CMD ["node", "dist/agent/main.js"]
