# Stage 1: build (compile TypeScript -> dist/)
FROM node:25.8-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: runtime -- production deps only, non-root, healthcheck.
# node:*-alpine already ships a "node" user (uid/gid 1000); reuse it
# rather than creating a new one -- a fixed `addgroup -g 1000` collides
# with that pre-existing group and fails the build.
FROM node:25.8-alpine
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
RUN chown -R node:node /app
USER node
ENV LOG_FORMAT=json LOG_LEVEL=info NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/livez',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/server.js"]
