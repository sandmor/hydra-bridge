# Build stage (TypeScript -> JS)
FROM node:20-alpine AS builder
WORKDIR /app

# Install deps (leverage Docker cache)
COPY package.json package-lock.json* ./
# Use npm install to avoid failing on out-of-sync lock files during local iteration
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build
RUN npm run build

# Runtime stage
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install prod deps only
COPY package.json package-lock.json* ./
# Install only production deps in the runtime image
RUN npm install --omit=dev

# Copy built files
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]