# 本次构建只解析一次官方 Bun 1.x；构建层与运行层复用该基础层。
FROM docker.io/oven/bun:1-slim AS bun-base

# 构建层：按锁文件安装依赖，并把 TypeScript 源码编译为 dist JS。
FROM bun-base AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun --no-env-file install --frozen-lockfile --ignore-scripts
COPY . .
# 编译后重装为仅生产依赖，运行层不带 TypeScript 等开发依赖。
RUN bun --no-env-file run build \
    && rm -rf node_modules \
    && bun --no-env-file install --production --frozen-lockfile --ignore-scripts

# 运行层：使用同一 Bun 版本，携带产物、生产依赖、许可证与健康检查脚本。
FROM bun-base
ARG VERSION
ARG COMMIT
LABEL org.opencontainers.image.title="Rovloom" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/ArnoChenFx/rovloom" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}"
WORKDIR /app
# 创建运行用户及配置、数据目录；命名卷首次挂载时继承此属主与权限。
RUN groupadd --gid 10001 rovloom \
    && useradd --uid 10001 --gid 10001 --home-dir /home/rovloom --no-create-home rovloom \
    && install -d -m 0700 -o 10001 -g 10001 /home/rovloom \
       /home/rovloom/.config /home/rovloom/.config/rovloom \
       /home/rovloom/.local /home/rovloom/.local/share /home/rovloom/.local/share/rovloom
COPY --from=build --chmod=0644 /app/package.json /app/bun.lock /app/LICENSE ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=0755 scripts/container/healthcheck.mjs /usr/local/bin/rovloom-healthcheck.mjs
ENV HOME=/home/rovloom ROVLOOM_HEALTH_PORT=9444 ROVLOOM_CONTAINER=1
USER 10001:10001
STOPSIGNAL SIGTERM
# 健康检查脚本用 Bun 的 fetch 请求本机 MCP 端点，不依赖 curl。
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 CMD ["bun", "/usr/local/bin/rovloom-healthcheck.mjs"]
ENTRYPOINT ["bun", "--no-env-file", "/app/dist/src/cli/main.js"]
CMD ["gateway"]
