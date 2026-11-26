# syntax=docker/dockerfile:1
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /src
# Node 25 and later no longer bundle corepack, so install a pinned one; it then runs the pnpm
# version named in package.json.
RUN npm install --global --ignore-scripts corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages packages
RUN pnpm --filter @hl-crm-db/sdk build && pnpm --filter @hl-crm-db/server build \
 && pnpm --filter @hl-crm-db/server deploy --prod --legacy /out
# The web UI: static files the API serves from its own origin (WEB_UI=false turns that off). Kept apart
# from /out so the runtime image can make them root-owned and read-only to the user the server runs as.
RUN pnpm --filter @hl-crm-db/web build && cp -r packages/web/dist /web \
 && find /web -type d -exec chmod 0755 {} + && find /web -type f -exec chmod 0644 {} +

RUN mkdir -p /out/data/blobs

# Runtime: distroless (no shell, no package manager, no npm), running as a non-root user.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a84242e747fbb5aaaa0180c273b6f7130ca34b3300082192ef58eea96089eb3c
LABEL org.opencontainers.image.title="hl-crm-db" \
      org.opencontainers.image.description="Open-source headless CRM backend: REST API, web UI, MCP servers and worker" \
      org.opencontainers.image.source="https://github.com/open-gtm/crm" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV NODE_ENV=production
WORKDIR /app
# The code and the web UI are root-owned and read-only to the server's user (the server reloads index.html
# when it changes, so the process must not be able to rewrite what it serves, nor swap the directory).
# Only the data directories belong to it.
COPY --from=build /out /app
COPY --from=build /web /app/web
COPY --from=build --chown=65532:65532 /out/data /app/data
COPY --from=build --chown=65532:65532 /out/data /data
# The AGPL licence travels with the distributed binaries.
COPY LICENSE /licenses/LICENSE
USER 65532
ENTRYPOINT ["/nodejs/bin/node", "dist/cli.js"]
CMD ["api"]
