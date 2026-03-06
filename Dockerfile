FROM node:20 AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts
RUN npm rebuild better-sqlite3
COPY --from=builder /app/dist ./dist
# We need these folders for the volume mounts
RUN mkdir -p data store groups

ENV NODE_ENV=production
ENV CONTAINER_RUNTIME=k8s

CMD ["node", "dist/index.js"]
