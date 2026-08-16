# Static build served by nginx. The frontend has no server-side logic and
# no secrets: everything it needs comes from the public game view and a
# launch token supplied in the URL by the operator.
FROM node:20-alpine AS builder
WORKDIR /app

# Which frontend to build. One Dockerfile serves both, so adding a third
# needs no new file.
ARG APP
ARG VITE_GAME_BACKEND_URL
ARG VITE_GAME_SOCKET_URL
ARG VITE_BACKOFFICE_API_URL
# Baked in at build time — Vite inlines these into the bundle, so they are
# public by construction. Never put anything secret in a VITE_ variable.
ENV VITE_GAME_BACKEND_URL=$VITE_GAME_BACKEND_URL
ENV VITE_GAME_SOCKET_URL=$VITE_GAME_SOCKET_URL
ENV VITE_BACKOFFICE_API_URL=$VITE_BACKOFFICE_API_URL

COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci --ignore-scripts

# Workspace packages first. Both frontends import @slots-engine/shared-types,
# which resolves through its built dist/*.d.ts — building the app alone fails
# with "cannot find module" on a clean checkout, where no dist/ yet exists.
RUN npm run build:packages
RUN npm run build -w apps/$APP

FROM nginx:1.27-alpine AS runtime
ARG APP
COPY --from=builder /app/apps/$APP/dist /usr/share/nginx/html
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
