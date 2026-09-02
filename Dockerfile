# syntax=docker/dockerfile:1
FROM node:24.4.0-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@10.22.0 --activate

FROM base AS build
COPY . /usr/src/app
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y python3 make g++ git python3-pip pkg-config libsecret-1-dev && rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Deploy only the nomploy app

ENV NODE_ENV=production
RUN pnpm --filter=@nomploy/server build
RUN pnpm --filter=./apps/dokploy run build

RUN pnpm --filter=./apps/dokploy --prod deploy --legacy /prod/nomploy

RUN cp -R /usr/src/app/apps/dokploy/.next /prod/nomploy/.next
RUN cp -R /usr/src/app/apps/dokploy/dist /prod/nomploy/dist

FROM base AS nomploy
WORKDIR /app

# Set production
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y curl unzip zip apache2-utils iproute2 rsync git-lfs wireguard-tools iptables && git lfs install && rm -rf /var/lib/apt/lists/*

# Nomad CLI — the deploy pipeline runs `nomad job run` to submit jobs to the
# control plane's own Nomad. (Remote-server deploys use that server's own CLI.)
ARG TARGETARCH
ARG NOMAD_VERSION=2.0.5
RUN curl -fsSL "https://releases.hashicorp.com/nomad/${NOMAD_VERSION}/nomad_${NOMAD_VERSION}_linux_${TARGETARCH}.zip" -o /tmp/nomad.zip \
    && unzip -o /tmp/nomad.zip -d /usr/local/bin/ \
    && rm /tmp/nomad.zip \
    && nomad --version

# Copy only the necessary files
COPY --from=build /prod/nomploy/.next ./.next
COPY --from=build /prod/nomploy/dist ./dist
COPY --from=build /prod/nomploy/next.config.mjs ./next.config.mjs
COPY --from=build /prod/nomploy/public ./public
COPY --from=build /prod/nomploy/package.json ./package.json
COPY --from=build /prod/nomploy/drizzle ./drizzle
COPY .env.production ./.env
COPY --from=build /prod/nomploy/components.json ./components.json
COPY --from=build /prod/nomploy/node_modules ./node_modules


# Install docker
RUN curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh --version 28.5.2 && rm get-docker.sh && curl https://rclone.org/install.sh | bash

# Install Nixpacks and tsx
# | VERBOSE=1 VERSION=1.21.0 bash

ARG NIXPACKS_VERSION=1.41.0
RUN curl -sSL https://nixpacks.com/install.sh -o install.sh \
    && chmod +x install.sh \
    && ./install.sh \
    && pnpm install -g tsx

# Install Railpack
ARG RAILPACK_VERSION=0.15.4
RUN curl -sSL https://railpack.com/install.sh | bash

# Install buildpacks
COPY --from=buildpacksio/pack:0.39.1 /usr/local/bin/pack /usr/local/bin/pack

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fs http://localhost:3000/api/trpc/settings.health || exit 1

  CMD ["sh", "-c", "pnpm run wait-for-postgres && exec pnpm start"]
