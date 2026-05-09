---
feature: cicd
plan: "[[plan]]"
spec: "[[spec]]"
created: 2026-05-08
---
# CI/CD — Tasks

**For this plan:** `[[plan]]`

7 tasks. Cada task termina em commit (exceto Task 0 que é só pre-flight). Quality-gate (`pnpm run quality-gate`) deve continuar verde após Task 2 (que é a única que mexe em arquivo lintável). Todos os outros commits adicionam só YAML/sh/md.

---

## Phase 0 — Pre-flight

### Task 0: Confirmar fatos da spec

**Purpose:** Validar 4 assumptions antes de escrever código que depende delas. Sem commit; findings ficam em comentários no plan.md se forem surpreendentes.

**Files:**
- Read-only: `apps/worker/src/webhook/server.ts`, `infra/Dockerfile`, `profile/.env.example`

- [ ] **Step 1: Confirmar shape do `/health`**

```
Read apps/worker/src/webhook/server.ts (lines 30-50)
```

Anotar:
- Que código HTTP retorna em `dbOpen=false` ("degraded")? Status 200 ou 503?
- Se sempre 200: healthcheck do compose **não pode** confiar só em `curl -f`; precisa filtrar pelo body (`grep -q '"status":"ok"'`).
- Se 503 em degraded: `curl -f` é suficiente.

**Decisão de design pra Task 2:** com base no shape, escolher entre:
- (A) `curl -fsS http://localhost:8080/health` (se status reflete saúde)
- (B) `curl -fsS http://localhost:8080/health | grep -q '"status":"ok"'` (se sempre 200)

- [ ] **Step 2: Confirmar `curl` no runtime image**

```bash
grep -n "curl" infra/Dockerfile
```

Esperado: linha 6 instala `curl` via `apt-get install`. Confirmar que está presente também na stage `runtime` (multi-stage — `curl` precisa estar instalado **na base que vira runtime**).

Olhando o Dockerfile: stage `base` (linha 4) já tem `curl`, e `runtime` (linha 28) faz `FROM base`. ✅

- [ ] **Step 3: Confirmar `docker-compose.local.yml` atual**

```
Read infra/docker-compose.local.yml
```

Confirmar que tem só `env_file: profile/.env.local` overrides (sem `build:`). Se sim, Task 2 adiciona `build:` lá. Se já tem `build:`, ajustar.

- [ ] **Step 4: Confirmar GitHub username e repo**

```bash
git remote -v
```

Esperado: `git@github.com:bielvelozo/Whis-Agent.git`. Se for username diferente, atualizar todas as referências nas Tasks 2-6 (image name `ghcr.io/<USERNAME>/whis-worker`).

---

## Phase 1 — Setup doc na frente

### Task 1: Escrever `docs/specs/0005-cicd/setup.md`

**Purpose:** Permitir que Gabriel rode os 11 passos manuais na EC2 em paralelo com Tasks 2-6.

**Files:**
- Create: `docs/specs/0005-cicd/setup.md`

- [ ] **Step 1: Criar `setup.md`**

```markdown
---
feature: cicd
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-05-08
---
# Setup one-time da EC2 + GitHub repo

Passos manuais executados **uma vez** pelo Gabriel antes do primeiro deploy automatizado funcionar. Não fazem parte do código — são config de infraestrutura.

Pré-requisitos: SSH funcionando na EC2 (deploy manual atual já tem isso).

---

## 1. Criar user dedicado `whis-deploy` na VM

```bash
ssh ec2-user@<EC2_HOST>  # ou ubuntu@, conforme AMI
sudo useradd -m -s /bin/bash whis-deploy
sudo usermod -aG docker whis-deploy
```

Verificar:
```bash
id whis-deploy
# uid=...(whis-deploy) gid=...(whis-deploy) groups=...(whis-deploy),...(docker)
```

## 2. Criar `/opt/whis` owned pelo deploy user

```bash
sudo mkdir -p /opt/whis
sudo chown -R whis-deploy:whis-deploy /opt/whis
```

## 3. Clonar o repo em `/opt/whis`

Como o user `whis-deploy` ainda não tem chave Git, clonar via HTTPS (read-only):

```bash
sudo -u whis-deploy git clone https://github.com/bielvelozo/Whis-Agent.git /opt/whis
```

Se o repo for privado, criar um deploy key (read-only) em GitHub `Settings → Deploy keys` e configurar `~/.ssh/config` no `whis-deploy`. Por ora o repo é público (assumir; ajustar se mudar).

## 4. Copiar `profile/` e `context/` do laptop pra VM

Esses dirs são gitignored — não vêm pelo `git clone`.

No laptop (Windows PowerShell):
```powershell
scp -r profile/ <user>@<EC2_HOST>:/tmp/whis-profile
scp -r context/ <user>@<EC2_HOST>:/tmp/whis-context
```

Na VM:
```bash
sudo mv /tmp/whis-profile /opt/whis/profile
sudo mv /tmp/whis-context /opt/whis/context
sudo chown -R whis-deploy:whis-deploy /opt/whis/profile /opt/whis/context
```

## 5. Gerar par SSH dedicado pro GitHub Actions

No laptop:
```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\whis-deploy -C "whis-deploy@github-actions" -N '""'
```

Cuidado: `-N ''` (sem passphrase) — Actions não pode digitar senha.

## 6. Adicionar pubkey em `authorized_keys` do `whis-deploy`

No laptop, copiar conteúdo de `~/.ssh/whis-deploy.pub` pro clipboard. Na VM:

```bash
sudo -u whis-deploy mkdir -p /home/whis-deploy/.ssh
sudo -u whis-deploy chmod 700 /home/whis-deploy/.ssh
sudo -u whis-deploy tee -a /home/whis-deploy/.ssh/authorized_keys < /tmp/whis-deploy.pub
sudo -u whis-deploy chmod 600 /home/whis-deploy/.ssh/authorized_keys
```

(Ou use `ssh-copy-id -i ~/.ssh/whis-deploy.pub whis-deploy@<EC2_HOST>` se preferir.)

Testar do laptop:
```powershell
ssh -i $HOME\.ssh\whis-deploy whis-deploy@<EC2_HOST> 'docker --version'
```

Esperado: print da versão do Docker, sem prompt de senha.

## 7. Gerar PAT do GitHub pra GHCR

Em https://github.com/settings/tokens (classic ou fine-grained):

- **Classic**: escopo `read:packages` apenas.
- **Fine-grained**: scope `Account permissions → packages` = `Read`.

Expiration: 90d ou 1y. **Anotar data de expiração** — quando próximo, regenerar e atualizar `GHCR_PAT` secret.

Copiar o token (mostrado uma vez).

## 8. Criar package GHCR (primeiro push)

Duas opções:

- **Deixar primeiro deploy criar** — first run de `deploy.yml` faz `docker push` que cria o package automaticamente. Depois, ir em `https://github.com/users/bielvelozo/packages/container/whis-worker/settings` e:
  1. Confirmar visibility = `private`.
  2. Em `Manage Actions access`, adicionar repo `Whis-Agent` com role `Write`.

- **Push manual primeiro** (preferível):
  ```powershell
  echo "<GHCR_PAT>" | docker login ghcr.io -u bielvelozo --password-stdin
  docker pull hello-world
  docker tag hello-world ghcr.io/bielvelozo/whis-worker:bootstrap
  docker push ghcr.io/bielvelozo/whis-worker:bootstrap
  ```
  Depois ajustar visibility + Actions access conforme item 1 acima.

## 9. Configurar 6 secrets do repo

Em `https://github.com/bielvelozo/Whis-Agent/settings/secrets/actions`, criar:

| Name | Valor |
|---|---|
| `EC2_HOST` | IP público ou DNS da EC2 |
| `EC2_USER` | `whis-deploy` |
| `EC2_SSH_KEY` | conteúdo de `~/.ssh/whis-deploy` (privada, **com** as linhas BEGIN/END) |
| `GHCR_PAT` | PAT criado no item 7 |
| `TELEGRAM_BOT_TOKEN` | mesmo do `profile/.env` (chave `TELEGRAM_BOT_TOKEN`) |
| `TELEGRAM_OWNER_CHAT_ID` | mesmo do `profile/.env` |

## 10. Confirmar Security Group da EC2

A SG da EC2 já aceita 22 do mundo (deploy manual atual depende disso). Sem mudança. Em `AWS Console → EC2 → Security Groups`, confirmar regra inbound:

- Type: SSH
- Port: 22
- Source: 0.0.0.0/0

(Se quiser endurecer no futuro: source = lista de IPs do GitHub Actions de https://api.github.com/meta. Fora do escopo desta spec.)

## 11. Smoke do setup (sem deploy ainda)

Antes de mergear `deploy.yml`, validar que SSH + docker login + git fetch funcionam manualmente. Do laptop:

```powershell
ssh -i $HOME\.ssh\whis-deploy whis-deploy@<EC2_HOST>
```

Na VM:
```bash
cd /opt/whis
git fetch --depth=1 origin main
echo "<GHCR_PAT>" | docker login ghcr.io -u bielvelozo --password-stdin
docker pull ghcr.io/bielvelozo/whis-worker:bootstrap
docker logout ghcr.io
```

Tudo OK = setup pronto. Pode mergear deploy.yml.

---

## Renovação do PAT

PAT expira. Quando faltar 1 mês:

1. Gerar novo PAT (item 7).
2. Atualizar secret `GHCR_PAT` em `Settings → Secrets`.
3. Revogar PAT antigo.

Sem isso, `docker pull` no `deploy.sh` falha com 401.
```

- [ ] **Step 2: Verificar render**

```bash
ls docs/specs/0005-cicd/setup.md
```

Esperado: arquivo existe, ~150 linhas.

- [ ] **Step 3: Commit**

```bash
git add docs/specs/0005-cicd/setup.md docs/specs/0005-cicd/plan.md docs/specs/0005-cicd/tasks.md
git commit -m "docs(spec): 0005-cicd plan + tasks + setup.md"
```

---

## Phase 2 — Compose + entrypoint

### Task 2: Mudanças em `docker-compose.yml`, `docker-compose.local.yml`, `entrypoint.sh`

**Files:**
- Modify: `infra/docker-compose.yml` (image, healthcheck, remover build)
- Modify: `infra/docker-compose.local.yml` (adicionar build)
- Modify: `infra/entrypoint.sh` (env drift check)

- [ ] **Step 1: Editar `infra/docker-compose.yml` — service `whis-worker`**

Trocar bloco do service `whis-worker` (linhas 34-54) de:

```yaml
  whis-worker:
    build:
      context: .
      dockerfile: infra/Dockerfile
    image: whis-worker:dev
    env_file: profile/.env
```

Pra:

```yaml
  whis-worker:
    image: ghcr.io/bielvelozo/whis-worker:${WHIS_IMAGE_TAG:-latest}
    env_file: profile/.env
```

E adicionar bloco `healthcheck:` antes de `volumes:`:

```yaml
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
```

(Se Task 0 Step 1 indicou que `/health` retorna 200 mesmo em degraded, trocar `test` pra `["CMD-SHELL", "curl -fsS http://localhost:8080/health | grep -q '\"status\":\"ok\"' || exit 1"]`.)

- [ ] **Step 2: Validar compose YAML**

```bash
docker compose -f infra/docker-compose.yml --project-directory . config > /dev/null
```

Expected: sem erro. Warnings sobre `WHIS_IMAGE_TAG` não setado são OK (cai no default `latest`).

- [ ] **Step 3: Editar `infra/docker-compose.local.yml` — adicionar build**

Trocar:

```yaml
services:
  evolution-api:
    env_file: profile/.env.local

  whis-worker:
    env_file: profile/.env.local
```

Pra:

```yaml
services:
  evolution-api:
    env_file: profile/.env.local

  whis-worker:
    build:
      context: .
      dockerfile: infra/Dockerfile
    image: whis-worker:dev
    env_file: profile/.env.local
```

(`image: whis-worker:dev` aqui sobrescreve o GHCR do compose principal pra dev local não precisar de pull autenticado.)

- [ ] **Step 4: Validar override de dev**

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml --project-directory . config | grep -A 1 "whis-worker:" | head -10
```

Expected: aparece bloco `build:` + `image: whis-worker:dev`.

- [ ] **Step 5: Editar `infra/entrypoint.sh` — env drift check**

Adicionar bloco entre linha 6 (`set -eu`) e linha 8 (`AGENT_SKILLS=...`):

```bash
# Validate profile/.env has all keys present in profile/.env.example.
# Catches drift where new env vars added to .env.example didn't make it
# to the VM's .env after a deploy.
ENV_FILE=/app/profile/.env
ENV_EXAMPLE=/app/profile/.env.example
if [ -f "$ENV_EXAMPLE" ] && [ -f "$ENV_FILE" ]; then
  MISSING=""
  while IFS= read -r line; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    [ -z "$key" ] && continue
    if ! grep -q "^${key}=" "$ENV_FILE"; then
      MISSING="${MISSING} ${key}"
    fi
  done < "$ENV_EXAMPLE"
  if [ -n "$MISSING" ]; then
    echo "FATAL: profile/.env missing keys from .env.example:${MISSING}" >&2
    echo "       Add these keys to /opt/whis/profile/.env on the VM and re-deploy." >&2
    exit 1
  fi
fi
```

- [ ] **Step 6: Lint shell**

Rodar shellcheck via container Docker (cobre Windows sem instalar nada):

```bash
docker run --rm -v "${PWD}:/mnt" koalaman/shellcheck:stable /mnt/infra/entrypoint.sh
```

Expected: zero warnings novos. Se sair warning sobre `${MISSING}` ou `${key}`, ajustar quoting.

- [ ] **Step 7: Smoke local — env drift check**

Criar arquivo temporário `/tmp/test-env`:
```bash
TELEGRAM_BOT_TOKEN=test
# Falta TELEGRAM_OWNER_CHAT_ID que existe no .env.example
```

Rodar entrypoint manualmente com env files trocados:
```bash
docker run --rm \
  -v "${PWD}/infra/entrypoint.sh:/usr/local/bin/whis-entrypoint.sh" \
  -v "${PWD}/profile/.env.example:/app/profile/.env.example:ro" \
  -v /tmp/test-env:/app/profile/.env:ro \
  -v "${PWD}/agent:/app/agent:ro" \
  -v "${PWD}/profile:/app/profile-orig:ro" \
  alpine:3 sh -c "apk add --no-cache bash >/dev/null && /usr/local/bin/whis-entrypoint.sh echo OK"
```

Expected: stderr `FATAL: profile/.env missing keys from .env.example: ...`, exit 1.

(Se simplificar isso for mais simples na hora, pode pular o smoke automatizado e validar manualmente quando o deploy real rodar — Task 7 cobre.)

- [ ] **Step 8: Quality gate**

```bash
pnpm run quality-gate
```

Expected: verde (este commit não toca em código TS).

- [ ] **Step 9: Commit**

```bash
git add infra/docker-compose.yml infra/docker-compose.local.yml infra/entrypoint.sh
git commit -m "feat(infra): compose aponta GHCR + healthcheck /health + entrypoint valida .env drift"
```

---

## Phase 3 — Deploy script

### Task 3: Escrever `infra/deploy.sh`

**Files:**
- Create: `infra/deploy.sh`

- [ ] **Step 1: Criar `infra/deploy.sh`**

```bash
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
COMPOSE="docker compose -f infra/docker-compose.yml --project-directory ."
STATE_FILE="/opt/whis/.last-deploy-sha"
HEALTH_RETRIES=30
HEALTH_INTERVAL=2

cd /opt/whis

echo "[deploy] Target SHA: ${TARGET_SHA}"

# 1. Sync code (atualiza bind mount agent/ + este próprio script)
echo "[deploy] git fetch + checkout"
git fetch --depth=1 origin main
git -c advice.detachedHead=false checkout "${TARGET_SHA}"

# 2. GHCR login
echo "[deploy] docker login ghcr.io"
echo "${GHCR_TOKEN:?missing GHCR_TOKEN env}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin

# 3. Save previous SHA pra rollback (vazio em first deploy)
PREVIOUS_SHA=$(cat "${STATE_FILE}" 2>/dev/null || echo "")
echo "[deploy] Previous SHA: ${PREVIOUS_SHA:-<none>}"

# 4. Pull + up
export WHIS_IMAGE_TAG="${TARGET_SHA}"
echo "[deploy] docker pull ${GHCR_IMAGE}:${TARGET_SHA}"
${COMPOSE} pull whis-worker
echo "[deploy] docker compose up -d whis-worker"
${COMPOSE} up -d whis-worker

# 5. Healthcheck loop
echo "[deploy] Waiting for /health (max $((HEALTH_RETRIES * HEALTH_INTERVAL))s)..."
for i in $(seq 1 "${HEALTH_RETRIES}"); do
  if ${COMPOSE} exec -T whis-worker curl -fsS http://localhost:8080/health > /dev/null 2>&1; then
    echo "[deploy] Healthy after ${i} attempt(s)"
    echo "${TARGET_SHA}" > "${STATE_FILE}"
    docker logout ghcr.io > /dev/null 2>&1 || true
    echo "[deploy] OK"
    exit 0
  fi
  sleep "${HEALTH_INTERVAL}"
done

# 6. Healthcheck failed — auto-rollback
echo "[deploy] HEALTHCHECK FAILED after $((HEALTH_RETRIES * HEALTH_INTERVAL))s" >&2

if [ -z "${PREVIOUS_SHA}" ]; then
  echo "[deploy] No PREVIOUS_SHA — first deploy, leaving as is" >&2
  docker logout ghcr.io > /dev/null 2>&1 || true
  exit 1
fi

echo "[deploy] Rolling back to ${PREVIOUS_SHA}"
git -c advice.detachedHead=false checkout "${PREVIOUS_SHA}"
export WHIS_IMAGE_TAG="${PREVIOUS_SHA}"
${COMPOSE} pull whis-worker
${COMPOSE} up -d whis-worker
docker logout ghcr.io > /dev/null 2>&1 || true
echo "[deploy] Rollback completed; deploy considered FAILED" >&2
exit 1
```

- [ ] **Step 2: Tornar executável**

```bash
chmod +x infra/deploy.sh
```

- [ ] **Step 3: Lint com shellcheck**

```bash
docker run --rm -v "${PWD}:/mnt" koalaman/shellcheck:stable /mnt/infra/deploy.sh
```

Expected: zero issues. Se aparecer SC2086 (word splitting em `${COMPOSE}`), é intencional — `COMPOSE` é uma string com múltiplos args. Pode adicionar `# shellcheck disable=SC2086` ou refatorar pra array (`COMPOSE=(docker compose ...)` + `"${COMPOSE[@]}"`). Refatoração é melhor — fazer.

Se refatorar pra array:
```bash
COMPOSE=(docker compose -f infra/docker-compose.yml --project-directory .)
# uso:
"${COMPOSE[@]}" pull whis-worker
"${COMPOSE[@]}" up -d whis-worker
"${COMPOSE[@]}" exec -T whis-worker curl ...
```

Re-rodar shellcheck até zero issues.

- [ ] **Step 4: Bash syntax check**

```bash
bash -n infra/deploy.sh
```

Expected: sem output (sintaxe OK).

- [ ] **Step 5: Commit**

```bash
git add infra/deploy.sh
git commit -m "feat(infra): deploy.sh idempotente com healthcheck + auto-rollback"
```

---

## Phase 4 — `ci.yml`

### Task 4: Criar `.github/workflows/ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Criar diretório**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Escrever `ci.yml`**

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality-gate:
    name: Quality gate
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10.33.0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Quality gate (lint + typecheck + test)
        run: pnpm run quality-gate

      - name: Build
        run: pnpm run build
```

- [ ] **Step 3: Lint com actionlint**

```bash
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:latest -color
```

Expected: zero issues. (Vai escanear todos os `.github/workflows/*.yml`.)

- [ ] **Step 4: Verificar sintaxe YAML**

```bash
docker run --rm -v "${PWD}/.github/workflows/ci.yml:/ci.yml:ro" mikefarah/yq:latest e /ci.yml > /dev/null
```

Expected: sem erro (yq parseou OK).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(ci): ci.yml roda quality-gate em PR e push main"
```

---

## Phase 5 — `deploy.yml`

### Task 5: Criar `.github/workflows/deploy.yml`

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Escrever `deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]

concurrency:
  group: deploy-prod
  cancel-in-progress: false

permissions:
  contents: read
  packages: write

env:
  IMAGE_NAME: ghcr.io/bielvelozo/whis-worker

jobs:
  gate:
    name: Quality gate
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.33.0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run quality-gate
      - run: pnpm run build

  build-and-push:
    name: Build & push GHCR
    needs: gate
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - name: Setup buildx
        uses: docker/setup-buildx-action@v3

      - name: Login GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build & push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/Dockerfile
          push: true
          tags: |
            ${{ env.IMAGE_NAME }}:${{ github.sha }}
            ${{ env.IMAGE_NAME }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    name: SSH deploy
    needs: build-and-push
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: SSH + run deploy.sh
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          envs: GHCR_TOKEN
          script: |
            cd /opt/whis
            bash infra/deploy.sh ${{ github.sha }}
        env:
          GHCR_TOKEN: ${{ secrets.GHCR_PAT }}

      - name: Notify Telegram on failure
        if: failure()
        run: |
          curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
            -d chat_id="${TG_CHAT}" \
            -d parse_mode=HTML \
            --data-urlencode "text=⚠️ <b>Whis deploy falhou</b>%0ASHA: <code>${SHA}</code>%0A${MSG}%0A<a href=\"${RUN_URL}\">Run</a>"
        env:
          TG_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TG_CHAT: ${{ secrets.TELEGRAM_OWNER_CHAT_ID }}
          SHA: ${{ github.sha }}
          MSG: ${{ github.event.head_commit.message }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

**Atenção sobre `appleboy/ssh-action` e env vars:** o action passa só vars listadas em `envs:` pra dentro do script SSH. Sem `envs: GHCR_TOKEN`, o `${GHCR_TOKEN}` chega vazio na VM e `deploy.sh` aborta com "missing GHCR_TOKEN".

- [ ] **Step 2: Lint com actionlint**

```bash
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:latest -color
```

Expected: zero issues. Possíveis warnings:
- `shellcheck` reclamando do step `Notify Telegram` (variáveis no `--data-urlencode`). Aceitável — escape via `%0A` é intencional.

- [ ] **Step 3: Verificar referência a secrets**

```bash
grep -E "secrets\." .github/workflows/deploy.yml
```

Esperado:
```
secrets.GITHUB_TOKEN
secrets.EC2_HOST
secrets.EC2_USER
secrets.EC2_SSH_KEY
secrets.GHCR_PAT
secrets.TELEGRAM_BOT_TOKEN
secrets.TELEGRAM_OWNER_CHAT_ID
```

7 secrets (`GITHUB_TOKEN` é automático). Confere com `setup.md` item 9 que lista 6 (sem GITHUB_TOKEN). ✅

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(ci): deploy.yml — gate + build GHCR + ssh + telegram on fail"
```

---

## Phase 6 — `rollback.yml`

### Task 6: Criar `.github/workflows/rollback.yml`

**Files:**
- Create: `.github/workflows/rollback.yml`

- [ ] **Step 1: Escrever `rollback.yml`**

```yaml
name: Rollback

on:
  workflow_dispatch:
    inputs:
      sha:
        description: 'Git SHA pra reverter (full 40-char SHA)'
        required: true
        type: string

concurrency:
  group: deploy-prod
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  rollback:
    name: SSH rollback
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Validate SHA format
        run: |
          if [[ ! "${{ inputs.sha }}" =~ ^[0-9a-f]{40}$ ]]; then
            echo "::error::Invalid SHA format. Need full 40-char hex."
            exit 1
          fi

      - name: SSH + run deploy.sh with rollback SHA
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ${{ secrets.EC2_USER }}
          key: ${{ secrets.EC2_SSH_KEY }}
          envs: GHCR_TOKEN
          script: |
            cd /opt/whis
            bash infra/deploy.sh ${{ inputs.sha }}
        env:
          GHCR_TOKEN: ${{ secrets.GHCR_PAT }}

      - name: Notify Telegram on failure
        if: failure()
        run: |
          curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
            -d chat_id="${TG_CHAT}" \
            -d parse_mode=HTML \
            --data-urlencode "text=⚠️ <b>Whis rollback falhou</b>%0ATarget SHA: <code>${SHA}</code>%0A<a href=\"${RUN_URL}\">Run</a>"
        env:
          TG_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TG_CHAT: ${{ secrets.TELEGRAM_OWNER_CHAT_ID }}
          SHA: ${{ inputs.sha }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}

      - name: Notify Telegram on success
        if: success()
        run: |
          curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
            -d chat_id="${TG_CHAT}" \
            -d parse_mode=HTML \
            --data-urlencode "text=↩️ <b>Whis rollback OK</b>%0ASHA: <code>${SHA}</code>"
        env:
          TG_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TG_CHAT: ${{ secrets.TELEGRAM_OWNER_CHAT_ID }}
          SHA: ${{ inputs.sha }}
```

(Rollback **avisa de sucesso também** — diferente do deploy normal — porque ação manual disparada à mão merece feedback positivo no celular.)

- [ ] **Step 2: Lint com actionlint**

```bash
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:latest -color
```

Expected: zero issues.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rollback.yml
git commit -m "feat(ci): rollback.yml — workflow_dispatch manual reusando deploy.sh"
```

---

## Phase 7 — Smoke real

### Task 7: Validar 11 acceptance criteria com deploy real

**Pré-requisitos:** `setup.md` (Task 1) executado pelo Gabriel — secrets configurados, EC2 pronta, primeiro push GHCR feito.

**Files:**
- Create: `docs/specs/0005-cicd/smoke-results.md`

- [ ] **Step 1: Push os commits das Tasks 2-6 pra `main`**

```bash
git push origin main
```

Esperado: triggers `ci.yml` E `deploy.yml`. Acompanhar em `https://github.com/bielvelozo/Whis-Agent/actions`.

- [ ] **Step 2: Verificar `ci.yml` rodou + passou**

Abrir Actions UI. Confirmar run "CI" verde. Anotar duration.

- [ ] **Step 3: Verificar `deploy.yml` rodou + passou**

Confirmar 3 jobs (gate, build-and-push, deploy) verdes. Anotar duration total.

- [ ] **Step 4: Verificar imagem em GHCR**

```bash
docker manifest inspect ghcr.io/bielvelozo/whis-worker:$(git rev-parse HEAD)
docker manifest inspect ghcr.io/bielvelozo/whis-worker:latest
```

(Requer `docker login ghcr.io` local com PAT.) Esperado: ambos retornam manifest válido.

- [ ] **Step 5: Verificar container na VM rodando a imagem nova**

SSH na EC2:
```bash
ssh -i ~/.ssh/whis-deploy whis-deploy@<EC2_HOST>
cd /opt/whis
cat .last-deploy-sha
docker compose -f infra/docker-compose.yml --project-directory . ps whis-worker
docker compose -f infra/docker-compose.yml --project-directory . exec whis-worker curl -fsS http://localhost:8080/health
```

Esperado:
- `.last-deploy-sha` = SHA do commit que disparou o deploy.
- `compose ps`: status `running` + `healthy`.
- `/health`: retorna `{ status: 'ok', ... }`.

- [ ] **Step 6: Validar PR gate (criar PR de teste)**

Branch local com erro de typecheck proposital:
```bash
git checkout -b test/ci-gate-fail
echo "const x: number = 'foo';" > apps/worker/src/_typecheck-test.ts
git add apps/worker/src/_typecheck-test.ts
git commit -m "test: trigger ci gate fail (will be reverted)"
git push -u origin test/ci-gate-fail
gh pr create --title "Test: CI gate fail" --body "Should fail typecheck. Will be closed without merge."
```

Esperado: PR fica vermelho, "Quality gate" job falha. Fechar o PR sem merge:
```bash
gh pr close --delete-branch
git checkout main
git branch -D test/ci-gate-fail 2>/dev/null || true
```

- [ ] **Step 7: Validar auto-rollback (deploy proposital com /health quebrado)**

Branch:
```bash
git checkout -b test/rollback-trigger
```

Editar `apps/worker/src/webhook/server.ts` linha 33-38, trocar:
```typescript
app.get('/health', async (c) => {
  const h = await deps.healthCheck();
  ...
```
Por:
```typescript
app.get('/health', async (c) => {
  throw new Error('intentional rollback test');
  const h = await deps.healthCheck();
  ...
```

Push:
```bash
git add apps/worker/src/webhook/server.ts
git commit -m "test: break /health to validate auto-rollback (will be reverted)"
git push origin test/rollback-trigger
```

(Note: este é commit numa branch de teste. Pra triggar deploy.yml mesmo, precisa ir pra `main` — o que é destrutivo. **Alternativa segura**: rodar o `deploy.sh` direto na VM com SHA quebrado:

```bash
ssh -i ~/.ssh/whis-deploy whis-deploy@<EC2_HOST>
cd /opt/whis
# Build + push imagem quebrada manualmente, ou reusar uma imagem antiga conhecida boa
GHCR_TOKEN="<PAT>" bash infra/deploy.sh <sha-broken>
```

Esperado: script avisa healthcheck FAILED, faz rollback pro PREVIOUS_SHA, exit 1. `cat .last-deploy-sha` ainda mostra SHA bom anterior.)

Limpar branch:
```bash
git checkout main
git branch -D test/rollback-trigger
git push origin --delete test/rollback-trigger 2>/dev/null || true
```

- [ ] **Step 8: Validar Telegram notif**

Conferir que mensagem chegou no chat do owner Telegram em **dois cenários**:
- Deploy.yml falhando (Step 7 ou similar artificial)
- Rollback.yml manual (testar disparando dispatch manual com SHA atual: `gh workflow run rollback.yml -f sha=$(git rev-parse HEAD)`).

- [ ] **Step 9: Validar `.env` drift check**

Na VM:
```bash
sudo -u whis-deploy bash
cd /opt/whis
sed -i.bak '/^TELEGRAM_BOT_TOKEN=/d' profile/.env  # remove uma chave
docker compose -f infra/docker-compose.yml --project-directory . restart whis-worker
docker compose -f infra/docker-compose.yml --project-directory . logs whis-worker | tail -10
```

Esperado: log `FATAL: profile/.env missing keys from .env.example: TELEGRAM_BOT_TOKEN`. Container em loop de restart.

Restaurar:
```bash
mv profile/.env.bak profile/.env
docker compose -f infra/docker-compose.yml --project-directory . restart whis-worker
```

- [ ] **Step 10: Escrever `smoke-results.md`**

```markdown
---
feature: cicd
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-05-08
---
# CI/CD smoke results — 0005-cicd

Resultados dos 11 acceptance criteria do `spec.md`.

| # | Criterion | Status | Evidência |
|---|---|---|---|
| 1 | `ci.yml` existe e dispara em PRs + push main | ✅ | Run id <ID>, branch test/ci-gate-fail vermelho, push main verde |
| 2 | `deploy.yml` executou com sucesso pelo menos uma vez | ✅ | Run id <ID>, SHA <SHA>, duration <Xmin> |
| 3 | `rollback.yml` testado via workflow_dispatch | ✅ | Run id <ID>, target SHA <SHA> |
| 4 | `infra/deploy.sh` em /opt/whis/infra/deploy.sh, executável | ✅ | `ls -la /opt/whis/infra/deploy.sh` mostra `-rwxr-xr-x` |
| 5 | Compose tem image GHCR + healthcheck | ✅ | `docker compose config` confirma |
| 6 | entrypoint.sh valida .env drift | ✅ | Step 9 deste smoke confirmou aborto com mensagem clara |
| 7 | Imagens em ghcr.io/bielvelozo/whis-worker:SHA + :latest | ✅ | `docker manifest inspect` retorna OK |
| 8 | 6 secrets configurados | ✅ | UI Settings → Secrets confere |
| 9 | Auto-rollback dispara + Telegram chega | ✅ | Step 7+8 deste smoke |
| 10 | setup.md documenta os 11 passos | ✅ | docs/specs/0005-cicd/setup.md |
| 11 | Quality gate continua verde | ✅ | Última run de ci.yml no main |

**Issues encontrados:** <listar ou "nenhum">
```

Preencher com IDs/SHAs reais durante o smoke.

- [ ] **Step 11: Atualizar status da spec pra "shipped"**

```bash
sed -i 's/^status: draft$/status: shipped/' docs/specs/0005-cicd/spec.md
sed -i "s/^shipped: null$/shipped: $(date -u +%Y-%m-%d)/" docs/specs/0005-cicd/spec.md
```

(No PowerShell Windows, usar Edit tool ao invés de sed.)

- [ ] **Step 12: Commit final**

```bash
git add docs/specs/0005-cicd/smoke-results.md docs/specs/0005-cicd/spec.md
git commit -m "docs(spec): 0005-cicd smoke results — shipped"
git push origin main
```

(Esse último push triggera deploy mais uma vez — esperado e idempotente.)
