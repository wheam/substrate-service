FROM node:22-slim

# git：clone/pull 实例；python3：跑实例 vendored 脚本（render-context 等）；ssh：deploy key 拉私库
RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
CMD ["./docker-entrypoint.sh"]
