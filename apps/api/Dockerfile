# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/proxy-api/package.json apps/proxy-api/package.json
RUN npm ci
COPY apps/api apps/api
RUN npm run build --workspace @signals/api

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production BACKEND_API_HOST=0.0.0.0 BACKEND_API_PORT=4100
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/package.json apps/api/package.json
# Migrations read from /repo/database/migrations at runtime (`npm run db:migrate`).
COPY database database
EXPOSE 4100
CMD ["node", "apps/api/dist/index.js"]
