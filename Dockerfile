FROM node:22-bookworm-slim AS base

# Install FFmpeg & FFprobe directly in the Linux runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./
COPY prisma ./prisma/

# Install dependencies and build Prisma client
RUN npm install
RUN npx prisma generate

# Copy application source code
COPY . .

# Build TypeScript to dist
RUN npm run build

EXPOSE 4000

CMD ["node", "dist/index.js"]
