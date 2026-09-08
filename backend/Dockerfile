# syntax=docker/dockerfile:1.7
# Himma backend — the ONE production artifact (docs/37 §4/§31; docs/38 §8).
#
# The same image runs every runtime invocation, selected by command:
#   API          : scripts/start-api.ts          (RUNTIME_ROLE=api)
#   worker       : scripts/start-worker.ts       (RUNTIME_ROLE=worker; hosts the scheduler)
#   maintenance  : scripts/start-maintenance.ts <job> (RUNTIME_ROLE=maintenance; short-lived)
#   migration    : scripts/db-migrate.ts / scripts/db-verify.ts (schema-owner credential)
#   provisioning : scripts/db-provision-runtime-roles.ts (admin credential; password-injected)
#
# Properties: multi-stage; deterministic `npm ci` from the lockfile; runtime
# dependencies only (tsx is a runtime dependency by W6-1 design — TypeScript
# is executed by tsx, the repository ships no transpiled bundle); non-root
# user; no .env, no tests, no fixtures, no git metadata, no dev server, no
# deterministic payment provider selectable in production (the code refuses
# it); no secret ever enters an ARG/ENV — every secret arrives at task start
# from the managed store. Node is PID 1 so SIGTERM reaches the W6
# graceful-shutdown handlers directly (no shell, no npm wrapper, no tsx CLI
# child process); the image runs on a read-only root filesystem with no
# writable location at all (W6-4A container certification).
#
# Reproducibility: the base image is pinned by digest (the multi-arch index
# digest of node:24-bookworm-slim at the first real build — W6-4A container
# certification; recorded in infra/README.md §11; bump deliberately). The AWS
# RDS global CA bundle is a PUBLIC trust anchor fetched at build time; its
# sha256 is printed in the build log and recorded per build.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# ---- deps: production dependency tree only -------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---- runtime -------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG HIMMA_GIT_SHA=unknown
ARG HIMMA_BUILD_DATE=unknown
LABEL org.opencontainers.image.title="himma-backend" \
      org.opencontainers.image.description="Himma production backend — api | worker | maintenance | migrate (one artifact, RUNTIME_ROLE selects)" \
      org.opencontainers.image.source="https://github.com/himma/himma" \
      org.opencontainers.image.revision="${HIMMA_GIT_SHA}" \
      org.opencontainers.image.created="${HIMMA_BUILD_DATE}" \
      org.opencontainers.image.vendor="Himma"

ENV NODE_ENV=production \
    TSX_DISABLE_CACHE=1

# The AWS RDS global CA bundle (public trust anchor; not a secret). The
# runtime points DATABASE_SSL_CA_FILE at it; verify-full is enforced by the
# application config for every non-loopback host.
ADD --chmod=0444 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/himma/certs/rds-global-bundle.pem
# BuildKit applies `--chmod` to the directories ADD creates as well (0444 →
# not traversable by the non-root runtime user). The trust directory must be
# world-traversable; the bundle itself stays read-only.
RUN chmod 0555 /etc/himma /etc/himma/certs \
 && sha256sum /etc/himma/certs/rds-global-bundle.pem

RUN groupadd --system --gid 10001 himma \
 && useradd  --system --uid 10001 --gid himma --home-dir /app --shell /usr/sbin/nologin himma \
 # The runtime never invokes a package manager (ENTRYPOINT is node): drop the
 # base image's bundled npm/npx/corepack/yarn — dead weight and scanner
 # findings (W6-4A container certification: Trivy HIGH in npm's bundled deps).
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=deps --chown=himma:himma /app/node_modules ./node_modules
COPY --chown=himma:himma package.json tsconfig.json ./
COPY --chown=himma:himma src ./src
COPY --chown=himma:himma scripts ./scripts
COPY --chown=himma:himma migrations ./migrations

USER himma:himma
ENV DATABASE_SSL_CA_FILE=/etc/himma/certs/rds-global-bundle.pem

# Node as PID 1 running the application IN-PROCESS through tsx's `--import`
# loader — never the tsx CLI (which forks the program into a child process and
# needs a writable /tmp for its IPC socket). Signals reach the application
# handlers directly, and no writable filesystem location is required
# (TSX_DISABLE_CACHE above keeps the loader from writing a compile cache), so
# the ECS read-only root filesystem needs no tmpfs.
ENTRYPOINT ["node", "--import", "/app/node_modules/tsx/dist/loader.mjs"]
CMD ["scripts/start-api.ts"]
