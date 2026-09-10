FROM node:20-slim

WORKDIR /app

# Install OpenSSL 1.1 for Prisma 5 (node:20-slim ships OpenSSL 3.0 only)
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    wget && \
    wget -q http://archive.debian.org/debian/pool/main/o/openssl/libssl1.1_1.1.1n-0+deb11u5_amd64.deb && \
    dpkg -i libssl1.1_1.1.1n-0+deb11u5_amd64.deb && \
    rm libssl1.1_1.1.1n-0+deb11u5_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL dependencies (dev needed for build)
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy source and generate Prisma client
COPY . .
RUN npx prisma generate

# Build the Remix app
RUN npm run build

# Prune devDependencies after build to keep image small
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
