FROM node:22-bookworm

# Install FUSE 2 (required by fuse-native) and git (for claude-agent-sdk)
RUN apt-get update && apt-get install -y \
    fuse \
    libfuse2 \
    libfuse-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies and approve build scripts
RUN pnpm install --frozen-lockfile
RUN pnpm approve-builds esbuild fuse-native || true

# Copy source
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle

# Build TypeScript
RUN pnpm build

# Create mount point and claude config directory
RUN mkdir -p /workspace
RUN mkdir -p /root/.claude

# Run the app (from /app so ./drizzle resolves correctly)
CMD ["node", "dist/main.js"]
