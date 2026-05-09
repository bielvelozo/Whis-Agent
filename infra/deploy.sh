#!/usr/bin/env bash
# Whis deploy script — runs on the EC2 VM in /opt/whis.
# Called by .github/workflows/deploy.yml and rollback.yml via SSH.
#
# Usage: bash infra/deploy.sh <git-sha>
# Env:   GHCR_TOKEN  (PAT with read:packages)

set -euo pipefail

TARGET_SHA="${1:?usage: deploy.sh <git-sha>}"
GHCR_USER="bielvelozo"
GHCR_IMAGE="ghcr.io/${GHCR_USER}/whis-worker"
COMPOSE=(docker compose -f infra/docker-compose.yml --project-directory .)
STATE_FILE="/opt/whis/.last-deploy-sha"
HEALTH_RETRIES=30
HEALTH_INTERVAL=2

cd /opt/whis

echo "[deploy] Target SHA: ${TARGET_SHA}"

# 1. Sync code (atualiza bind mount agent/ + este próprio script).
echo "[deploy] git fetch + checkout"
git fetch --depth=1 origin main
git -c advice.detachedHead=false checkout "${TARGET_SHA}"

# 2. GHCR login.
echo "[deploy] docker login ghcr.io"
echo "${GHCR_TOKEN:?missing GHCR_TOKEN env}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin

# 3. Save previous SHA pra rollback (vazio em first deploy).
PREVIOUS_SHA=$(cat "${STATE_FILE}" 2>/dev/null || echo "")
echo "[deploy] Previous SHA: ${PREVIOUS_SHA:-<none>}"

# 4. Pull + up.
export WHIS_IMAGE_TAG="${TARGET_SHA}"
echo "[deploy] docker pull ${GHCR_IMAGE}:${TARGET_SHA}"
"${COMPOSE[@]}" pull whis-worker
echo "[deploy] docker compose up -d whis-worker"
"${COMPOSE[@]}" up -d whis-worker

# 5. Healthcheck loop.
echo "[deploy] Waiting for /health (max $((HEALTH_RETRIES * HEALTH_INTERVAL))s)..."
for i in $(seq 1 "${HEALTH_RETRIES}"); do
  if "${COMPOSE[@]}" exec -T whis-worker curl -fsS http://localhost:8080/health > /dev/null 2>&1; then
    echo "[deploy] Healthy after ${i} attempt(s)"
    echo "${TARGET_SHA}" > "${STATE_FILE}"
    docker logout ghcr.io > /dev/null 2>&1 || true
    echo "[deploy] OK"
    exit 0
  fi
  sleep "${HEALTH_INTERVAL}"
done

# 6. Healthcheck failed — auto-rollback.
echo "[deploy] HEALTHCHECK FAILED after $((HEALTH_RETRIES * HEALTH_INTERVAL))s" >&2

if [ -z "${PREVIOUS_SHA}" ]; then
  echo "[deploy] No PREVIOUS_SHA — first deploy, leaving as is" >&2
  docker logout ghcr.io > /dev/null 2>&1 || true
  exit 1
fi

echo "[deploy] Rolling back to ${PREVIOUS_SHA}"
git -c advice.detachedHead=false checkout "${PREVIOUS_SHA}"
export WHIS_IMAGE_TAG="${PREVIOUS_SHA}"
"${COMPOSE[@]}" pull whis-worker
"${COMPOSE[@]}" up -d whis-worker
docker logout ghcr.io > /dev/null 2>&1 || true
echo "[deploy] Rollback completed; deploy considered FAILED" >&2
exit 1
