FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci

FROM deps AS builder

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server.js ./server.js
COPY routes ./routes
COPY controllers ./controllers
COPY services ./services

EXPOSE 3001

CMD ["node", "server.js"]
