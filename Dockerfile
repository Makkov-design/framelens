# Build stage: bundle the server into a single file.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts/build.mjs ./scripts/
RUN npm run bundle

# Runtime stage: Node, ffmpeg from Alpine's packages (the pinned ffmpeg build is glibc-only) and the bundle, run as
# the unprivileged "node" user. yt-dlp is fetched on first use: the pinned, SHA-256-checked musl build.
FROM node:24-alpine
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/framelens.mjs ./framelens.mjs
USER node
# MCP over stdio: run with `docker run -i`.
ENTRYPOINT ["node", "framelens.mjs"]
