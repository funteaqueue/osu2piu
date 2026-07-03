# build context: repository root
FROM node:22-alpine AS frontend
WORKDIR /app
COPY web/frontend/package*.json ./
RUN npm ci
COPY web/frontend ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /app
COPY web/server/package*.json ./
RUN npm ci
COPY web/server ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=server /app/node_modules ./node_modules
COPY --from=server /app/dist ./dist
COPY --from=server /app/package.json ./
COPY --from=frontend /app/dist ./public
ENV FRONTEND_DIST=/app/public \
    PROJECTS_DIR=/data/projects \
    ENGINE_URL=http://engine:8000 \
    PUBLISH_DIR=/publish
EXPOSE 8080
CMD ["node", "dist/index.js"]
