FROM node:20-alpine as builder

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --production=false

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:20-alpine

RUN apk add --no-cache python3 make g++ \
    && mkdir -p /app/data

WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --production \
    && yarn cache clean \
    && apk del make g++

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV WATCHDOG_DB_PATH=/app/data/watchdog.db

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
