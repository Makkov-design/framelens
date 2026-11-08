# Build stage: bundle the server into a single file.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts/build.mjs ./scripts/
RUN npm run bundle

# Runtime stage: just Node and the bundle, run as the unprivileged "node" user.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/framelens.mjs ./framelens.mjs
USER node
# MCP over stdio: run with `docker run -i`.
ENTRYPOINT ["node", "framelens.mjs"]
