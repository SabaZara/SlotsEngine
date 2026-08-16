# Shared by every service — which one is built is chosen by the SERVICE
# build arg, so adding a service needs no new Dockerfile.
ARG SERVICE

FROM node:20-alpine AS builder
WORKDIR /app

# Manifests first, so the dependency layer caches independently of source
# changes — editing a source file shouldn't reinstall node_modules.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci --ignore-scripts
RUN npm run build

# Reinstall production dependencies only, into a clean tree the runtime
# stage copies wholesale. Dev dependencies (TypeScript, tsx, the test
# runner) have no business in a running service.
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app

# Never run as root: a container escape from an unprivileged process is a
# much smaller problem than one from root.
RUN addgroup -S app && adduser -S app -G app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/packages ./packages
COPY --from=builder --chown=app:app /app/apps ./apps
COPY --from=builder --chown=app:app /app/package.json ./package.json

USER app

# Baked in at build time so the runtime CMD doesn't depend on the build arg
# still being present.
ENV SERVICE_DIR=/app/apps/${SERVICE}
CMD ["sh", "-c", "node $SERVICE_DIR/dist/index.js"]
