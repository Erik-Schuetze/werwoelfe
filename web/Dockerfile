# The operator console. It talks to the Kubernetes API to create one Job per
# game (or, for local development, to the Docker daemon), so the image carries
# no Docker CLI and no compiler toolchain: better-sqlite3 ships a Node-API
# prebuilt binding for linux-x64, and every other runtime dependency is plain
# JavaScript.

# --- build stage -----------------------------------------------------------
FROM node:26-bookworm-slim AS build

WORKDIR /app

# npm runs node-gyp for better-sqlite3 because the package ships a binding.gyp,
# even though its gyp file no-ops when the bundled Node-API prebuild is present.
# gyp still needs Python (and a compiler should it ever fall back to a source
# build), so the toolchain lives here. This whole stage is discarded, so none of
# it reaches the served image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

# Install from the lockfile first so the dependency layer is cached
# independently of the application source.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- runtime stage ---------------------------------------------------------
FROM node:26-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Only the compiled output and its runtime dependencies cross into the served
# image; the compiler toolchain and dev-only packages stay in the build stage.
# next.config.ts is needed at boot too: `next start` loads it, and its
# cacheComponents setting decides the route caching behaviour, so serving
# without it turns dynamic routes into a DYNAMIC_SERVER_USAGE error.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts

# The console runs as a non-root user whose uid/gid matches the engine image's
# distroless nonroot user (gcr.io/distroless/static-debian12:nonroot), so both
# containers in a game share one UID story. Port 3000 is above 1024, so binding
# it needs no privileges.
#
# At runtime the container is meant to run with a read-only root filesystem, so
# two paths must be backed by writable mounts:
#   * /tmp                 - scratch space for Node and Next.js
#   * /app/.next/cache     - Next.js runtime cache
# The Kubernetes manifest supplies these mounts; the chown below keeps the
# cache writable for a plain `docker run` without those mounts.
RUN mkdir -p /app/.next/cache && chown -R 65532:65532 /app/.next/cache

USER 65532:65532

EXPOSE 3000

CMD ["npm", "run", "start"]
