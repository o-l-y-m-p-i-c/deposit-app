FROM node:20-slim

WORKDIR /app

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
