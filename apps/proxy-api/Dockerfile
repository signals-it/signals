# Build from the repository root: docker build -f apps/proxy-api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/proxy-api/package.json apps/proxy-api/package.json
RUN npm ci
COPY apps/proxy-api apps/proxy-api
RUN npm run build --workspace @signals/proxy-api

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/proxy-api/dist apps/proxy-api/dist
COPY --from=build /repo/apps/proxy-api/package.json apps/proxy-api/package.json
EXPOSE 4000
CMD ["node", "apps/proxy-api/dist/index.js"]
