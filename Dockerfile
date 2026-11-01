# Imagem da API para rodar várias instâncias com docker compose (perfil "app")
FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY tsconfig.json bunfig.toml ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/main.ts"]
