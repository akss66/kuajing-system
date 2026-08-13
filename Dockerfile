FROM node:24-alpine AS build

WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=2048 \
    DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_SECRET=build-only-secret-with-at-least-32-characters \
    BETTER_AUTH_URL=https://shop.tzxai.top \
    PII_ENCRYPTION_KEY=CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/data/catalog-assets \
    && chown -R nextjs:nodejs /app/data

COPY --from=build --chown=nextjs:nodejs /app /app

USER nextjs
EXPOSE 3000

CMD ["npm", "start"]
