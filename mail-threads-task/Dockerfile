FROM node:22.16.0-bookworm-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
CMD ["node", "--experimental-strip-types", "src/worker.mts"]
