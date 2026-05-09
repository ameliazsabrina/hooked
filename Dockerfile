FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS build
COPY . .

RUN echo "=== repo layout ===" && ls -la packages/shared/ && echo "=== shared src ===" && ls -la packages/shared/src/

RUN pnpm install --frozen-lockfile --ignore-scripts

RUN echo "=== building shared ===" && cd packages/shared && npx tsc --listEmittedFiles

RUN echo "=== shared dist contents ===" && ls -la packages/shared/dist/ && test -f packages/shared/dist/index.js && test -f packages/shared/dist/index.d.ts

RUN echo "=== shared via symlink ===" && ls -la packages/server/node_modules/@hooked/shared/dist/

RUN echo "=== building server ===" && pnpm --filter @hooked/server build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/packages/server
CMD ["node", "dist/index.js"]
