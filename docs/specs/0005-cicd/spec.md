---
status: shipped
feature: cicd
created: 2026-05-08
shipped: 2026-05-10
---
# CI/CD — GitHub Actions → GHCR → SSH deploy na EC2

**Status:** Draft
**Scope:** Automatizar o deploy do Whis na EC2 (hoje 100% manual via SSH + `git pull` + `docker compose up --build`) com GitHub Actions. Pipeline em duas etapas: (1) `ci.yml` roda quality-gate em PRs e push em `main`; (2) `deploy.yml` builda imagem em runners do GitHub, publica no GitHub Container Registry (GHCR) taggeada por commit SHA + `latest`, conecta via SSH na EC2 e roda script idempotente que faz `git pull` (pra atualizar bind mounts de `agent/`), `docker pull`, `compose up -d` e healthcheck HTTP via `/health` já existente. Falha em qualquer etapa notifica o Gabriel via Telegram usando o mesmo bot/chat ID que o Whis já usa. Inclui workflow de rollback manual (`workflow_dispatch` com input `sha`) e auto-rollback no script quando healthcheck falha. Fora de escopo: ECS/Fargate, múltiplos ambientes, blue-green, monitoramento pós-deploy.

## Context

Hoje o ciclo de deploy do Whis é: Gabriel commita em `main` localmente, faz SSH na EC2, `git pull`, `pnpm run docker:build`, `pnpm run docker:down && docker:up`. Funciona, mas tem três problemas práticos:

1. **Build pesa na própria VM de produção** — a inst. EC2 (presumivelmente t3.small/medium pra projeto pessoal) gasta CPU/RAM rebuilding o multi-stage Dockerfile do `node:24-slim` toda vez. Em t3.small já chegou perto de OOM em commits anteriores.
2. **Sem rastreabilidade da imagem** — qual SHA está rodando agora? Resposta hoje: `git log -1` na VM. Sem versionamento por imagem, rollback exige `git revert` + rebuild (lento e propenso a estado inconsistente).
3. **Sem rede de segurança automatizada** — Gabriel pode esquecer de rodar `pnpm run quality-gate` antes do push. Tipicamente roda — mas o gate humano falha em commits de pressa.

A spec resolve isso adicionando um pipeline GitHub Actions que faz o trabalho fora da VM (build em runners do GitHub, publica imagem versionada em GHCR), valida via gates antes de deploy, e a VM apenas puxa imagem pronta + reinicia. O deploy continua sendo na mesma EC2 com Docker Compose — sem migração de runtime, sem reescrita de infra.

**Decisões fundantes confirmadas no brainstorming (2026-05-08):**

- **Plataforma: GitHub Actions.** Repo já está em `github.com/bielvelozo/Whis-Agent`; zero infra extra; integração nativa com PRs e `secrets`.
- **Estratégia de deploy: build no Actions → push GHCR → SSH + `docker pull`.** Build sai da VM de prod; imagem versionada por SHA; rollback é re-tag, não rebuild.
- **Quality gates obrigatórios antes de deploy:** `pnpm install --frozen-lockfile` + `pnpm run quality-gate` (lint + typecheck + test) + `pnpm run build`. Mesmo gate roda em PRs (sem deploy) e em push `main` (com deploy).
- **Trigger: push em `main`.** Continuous deployment, alinhado com a regra do AGENTS.md de "trabalhe em main direto pra MVP". Sem ambiente de staging.
- **Notificação de falha: Telegram via bot do Whis.** Reaproveita `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_CHAT_ID` que o agente já usa, expostos como secrets do repo. Falha em qualquer step do pipeline (gate, build, push, ssh, healthcheck) dispara mensagem.
- **Healthcheck via HTTP `/health`.** Endpoint já existe em `apps/worker/src/webhook/server.ts:33` (Hono, porta 8080). Compose ganha `healthcheck:` que faz `curl -f http://localhost:8080/health`. Container só é "saudável" quando o app de fato bootou — não basta processo `running`.
- **Rollback duplo: auto no script + manual via workflow.** `deploy.sh` salva tag anterior antes do pull e reverte se healthcheck falhar (cobre falha imediata). `rollback.yml` com `workflow_dispatch` aceita SHA como input pra reverter de fora (cobre falhas que aparecem depois).
- **Dois bind mounts continuam vivos**: `./agent` (skills + SOUL.md, no repo) e `./profile` + `./context` (gitignored, vivem só na VM). Implicação: deploy precisa de `git pull` *e* `docker pull` — código TS atualiza pela imagem, mas `agent/` atualiza pelo git pull. Ordem importa: `git pull` antes do `compose up` pra não ter janela de SHA dessincronizado.
- **Validação de drift de `.env` no `entrypoint.sh`.** Pra cada chave em `profile/.env.example`, abortar com erro claro se faltar em `profile/.env`. Mitiga bug clássico onde nova env var passa o gate (porque o `.env.example` foi commitado) mas crasha no boot da VM (porque o `.env` real não foi atualizado).
- **Concurrency group `deploy-prod` com `cancel-in-progress: false`** — dois pushes em sequência rápida não cancelam deploy em andamento (não dá pra abortar SSH limpo) e não rodam paralelo.
- **GHCR image privada** (default do GHCR), pull autenticado via PAT com escopo `read:packages` no `deploy.sh`. Login a cada deploy (simples, sem depender de `~/.docker/config.json` persistente).
- **Deploy user dedicado na VM (`whis-deploy`)** — usuário Linux separado do `ubuntu`/`ec2-user`, com chave SSH própria gerada só pra Actions, no grupo `docker`. Limita blast radius se a chave do GitHub vazar.

## Problem Statement

Deploy do Whis hoje é manual e sem rede de segurança. Resolvemos com pipeline GitHub Actions que:

1. **Roda gates automaticamente** em todo PR e push em `main` (`quality-gate` + `build`), bloqueando merge se falhar.
2. **Builda fora da VM** em runners GitHub e publica imagem em GHCR taggeada por commit SHA + `latest`, eliminando carga de build da prod.
3. **Faz deploy automático em push `main`** via SSH + script idempotente: `git pull`, `docker pull`, `compose up -d`, healthcheck HTTP, auto-rollback se falhar.
4. **Notifica Gabriel no Telegram** quando qualquer etapa falha, usando o mesmo bot/chat ID do agente.
5. **Permite rollback manual** via `workflow_dispatch` informando SHA anterior — sem precisar SSH manual.

A spec **não muda runtime nem arquitetura** — continua EC2 + Docker Compose. Só automatiza e versiona o que já existe.

## Non-Goals

Explicitamente **fora do escopo** desta spec:

1. **Migração pra ECS Fargate / ECR.** Foi opção considerada no brainstorming e descartada — não justifica trabalho/custo pra uso pessoal solo. Spec separada se virar relevante.
2. **Múltiplos ambientes (staging/prod).** Só `prod`. Whis é agente pessoal; staging = repo branch + dev local.
3. **Blue-green / zero-downtime deploy.** `compose up -d` aceita ~10s de janela durante restart. Aceitável pro caso de uso.
4. **Migrations de DB automatizadas.** Whis usa SQLite local, schema é gerenciado em código por `@whis/storage`. Não há banco compartilhado.
5. **Monitoramento/observabilidade pós-deploy** (CloudWatch, Sentry, traces). Spec separada.
6. **Backup automatizado dos volumes Docker** (`whis_data`, `claude_home`, `gcal_tokens`). Spec separada — volumes hoje persistem mas backup é manual.
7. **Renovação automática do GHCR PAT.** PAT expira em até 1 ano. Documentado como risco; renovação manual com lembrete.
8. **Restringir SG da EC2 aos IP ranges do GitHub Actions.** SG fica aberto na 22 com chave SSH forte. Endurecimento futuro se houver demanda.
9. **Cache de dependências pnpm cross-run** além do que `actions/setup-node@v4` já faz nativamente.
10. **Deploy parcial / canário.** Whis é single-instance; canário não faz sentido.
11. **Detecção automática de drift entre `.env.example` e `.env` em CI.** A validação acontece no `entrypoint.sh` no boot do container (na VM), não no workflow — porque o CI não tem acesso ao `.env` real da VM.
12. **Validação de imagem com Trivy/Grype antes do push.** Pode entrar em iteração futura; v1 confia no `node:24-slim` upstream.
13. **Notificação de sucesso.** Só falha. Sucesso é visto no Actions UI quando precisar confirmar.

## Constraints

**Técnicas:**

- Repo: `github.com/bielvelozo/Whis-Agent`. Default branch: `main`.
- Runtime de prod: 1× EC2 (Linux Ubuntu/Amazon Linux 2 — confirmar no setup) com Docker + Docker Compose v2 instalados.
- Imagem base do build: `node:24-slim` (Dockerfile linha 4). Multi-stage com 4 stages (`base`, `deps`, `builder`, `runtime`).
- pnpm 10.33.0 ativado via Corepack (Dockerfile linha 8 — `package.json` define como `packageManager`).
- Quality gate: `pnpm run quality-gate` = `turbo run lint typecheck test --concurrency=10`.
- Build: `pnpm turbo run build --filter=@whis/worker...`.
- Endpoint healthcheck: `GET http://localhost:8080/health` (Hono server em `apps/worker/src/webhook/server.ts:33`). Retorna `{ status: 'ok' | 'degraded' }`.
- `curl` está instalado no runtime (Dockerfile linha 5-7).

**De compose:**

- `infra/docker-compose.yml` é o compose canônico de prod.
- Volumes nomeados (`whis_data`, `evolution_pg_data`, `evolution_instances`, `evolution_store`, `gcal_tokens`) **persistem entre deploys** — nunca tocar.
- Volume `claude_home` é declarado `external: true` (criado uma vez via `docker volume create claude_home` durante setup inicial).
- Bind mounts `./agent`, `./profile`, `./context` mapeados a partir de `/opt/whis` na VM.
- Serviços `evolution-api` + `postgres` estão atrás do profile `whatsapp` (não rodam em deploy default — só com `--profile whatsapp`). Pipeline de deploy não toca neles.
- Compose hoje tem `image: whis-worker:dev` + `build: ...`. Spec muda pra `image: ghcr.io/bielvelozo/whis-worker:${WHIS_IMAGE_TAG:-latest}`. `build:` migra pra `infra/docker-compose.local.yml` (override usado por `pnpm run docker:up:local`).

**De segurança:**

- Chave SSH usada pelo Actions é nova, gerada no laptop, par só com `~/.ssh/authorized_keys` do user `whis-deploy` na VM. Nunca reusar a chave pessoal do Gabriel.
- PAT do GHCR com escopo `read:packages` apenas. Sem `write` (push é feito via `GITHUB_TOKEN` automático do workflow, não via PAT).
- Secrets do GitHub (`EC2_SSH_KEY_B64`, `GHCR_PAT`, `TELEGRAM_BOT_TOKEN`) ficam só em "Repository secrets". Não usar Environment secrets (sobre-engineering pra um único ambiente). SSH key vai em base64 (não raw PEM) porque o paste do web UI sofre mangling de line endings.

**De convenção:**

- Idioma PT-BR em commits (AGENTS.md). Workflows e scripts em inglês.
- Sem footer `Co-Authored-By` (memory `feedback_commits_no_coauthor`).
- Conventional Commits — esta spec em geral será mergada com `feat(infra): ...` / `feat(ci): ...`.

## Architecture

Pipeline em **três workflows** + **um script na VM** + **mudanças menores em compose/entrypoint**.

```
┌──────────────────────────────────────────────────────────────┐
│  GitHub Actions                                              │
│                                                              │
│  ci.yml                deploy.yml             rollback.yml   │
│  (PR + push main)      (push main)            (manual)       │
│  ┌─────────────┐       ┌──────────────┐       ┌───────────┐  │
│  │ quality-gate│       │ gate (idem)  │       │ ssh deploy│  │
│  │ + build     │       │ build buildx │       │ com SHA   │  │
│  └─────────────┘       │ push GHCR    │       │ informado │  │
│                        │ ssh deploy   │       └───────────┘  │
│                        │ notify telegm│                      │
│                        └──────┬───────┘                      │
└───────────────────────────────┼──────────────────────────────┘
                                │ ssh
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  EC2 — /opt/whis (owner: whis-deploy)                        │
│                                                              │
│  /opt/whis/infra/deploy.sh ${SHA}                            │
│   1. git fetch + reset hard                                  │
│   2. docker login ghcr.io                                    │
│   3. PREVIOUS_TAG=$(read .last-deploy-sha)                   │
│   4. WHIS_IMAGE_TAG=${SHA} docker compose pull whis-worker   │
│   5. WHIS_IMAGE_TAG=${SHA} docker compose up -d whis-worker  │
│   6. healthcheck loop curl /health (30 tentativas × 2s)      │
│   7. on success: echo ${SHA} > .last-deploy-sha              │
│      on failure: rollback p/ ${PREVIOUS_TAG} + exit 1        │
│                                                              │
│  Volumes (nunca tocados):                                    │
│   - whis_data (DB SQLite)                                    │
│   - claude_home (credentials Claude OAuth)                   │
│   - gcal_tokens (OAuth Google Calendar)                      │
└──────────────────────────────────────────────────────────────┘
```

### Componentes

#### C1 — `.github/workflows/ci.yml`

**Trigger:** `pull_request` (target `main`), `push` em `main`.
**Permissões:** default (read).
**Concorrência:** group `ci-${{ github.ref }}`, `cancel-in-progress: true` (em PR é OK cancelar).

Single job `quality-gate` que:
1. `actions/checkout@v4`
2. `pnpm/action-setup@v4` com versão do `package.json`
3. `actions/setup-node@v4` com Node 24 + cache pnpm
4. `pnpm install --frozen-lockfile`
5. `pnpm run quality-gate`
6. `pnpm run build`

Sem deploy. Sem build de imagem Docker. Só validação de código.

#### C2 — `.github/workflows/deploy.yml`

**Trigger:** `push` em `main` apenas.
**Permissões:** `contents: read`, `packages: write` (pra push em GHCR via `GITHUB_TOKEN`).
**Concorrência:** group `deploy-prod`, `cancel-in-progress: false`.

Três jobs em sequência:

**`gate`** — idêntico ao job de `ci.yml`. (Sim, redundante com `ci.yml` rodando em paralelo. Aceitável: garante que deploy nunca pula gate mesmo se alguém mexer em `ci.yml`.)

**`build-and-push`** — `needs: gate`:
1. `actions/checkout@v4`
2. `docker/setup-buildx-action@v3`
3. `docker/login-action@v3` com `registry: ghcr.io`, user `${{ github.actor }}`, password `${{ secrets.GITHUB_TOKEN }}`
4. `docker/build-push-action@v6`:
   - `context: .`
   - `file: infra/Dockerfile`
   - `push: true`
   - `tags: ghcr.io/bielvelozo/whis-worker:${{ github.sha }}` + `ghcr.io/bielvelozo/whis-worker:latest`
   - `cache-from: type=gha`, `cache-to: type=gha,mode=max`

**`deploy`** — `needs: build-and-push`:
1. `appleboy/ssh-action@v1` com host/user/key dos secrets, executando `bash /opt/whis/infra/deploy.sh ${{ github.sha }}` e passando `GHCR_TOKEN=${{ secrets.GHCR_PAT }}` como env.
2. Step com `if: failure()` chama Bot API do Telegram via `curl` informando SHA + commit message + link pro run.

#### C3 — `.github/workflows/rollback.yml`

**Trigger:** `workflow_dispatch` com input `sha` (string, required).
**Permissões:** `contents: read`.
**Concorrência:** mesmo group `deploy-prod` que `deploy.yml`.

Single job que faz SSH + roda `bash /opt/whis/infra/deploy.sh ${{ inputs.sha }}` — exatamente o mesmo script. Reaproveita toda a lógica.

#### C4 — `infra/deploy.sh`

Script shell idempotente, vai pro repo (commitado), copiado pra `/opt/whis/infra/deploy.sh` via `git pull`. Recebe SHA como `$1`.

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET_SHA="${1:?usage: deploy.sh <sha>}"
COMPOSE="docker compose -f infra/docker-compose.yml --project-directory ."
STATE_FILE="/opt/whis/.last-deploy-sha"

cd /opt/whis

# 1. Sync code (pra atualizar bind mount agent/)
git fetch --depth=1 origin main
git -c advice.detachedHead=false checkout "${TARGET_SHA}"

# 2. GHCR login
echo "${GHCR_TOKEN:?missing GHCR_TOKEN}" | docker login ghcr.io -u bielvelozo --password-stdin

# 3. Save previous SHA pra rollback
PREVIOUS_SHA=$(cat "${STATE_FILE}" 2>/dev/null || echo "")

# 4. Pull + up
export WHIS_IMAGE_TAG="${TARGET_SHA}"
${COMPOSE} pull whis-worker
${COMPOSE} up -d whis-worker

# 5. Healthcheck
echo "Waiting for /health..."
for i in {1..30}; do
  if ${COMPOSE} exec -T whis-worker curl -fsS http://localhost:8080/health > /dev/null; then
    echo "Healthy after ${i} attempt(s)"
    echo "${TARGET_SHA}" > "${STATE_FILE}"
    exit 0
  fi
  sleep 2
done

# 6. Auto-rollback
echo "Healthcheck FAILED — rolling back to ${PREVIOUS_SHA:-<none>}"
if [ -n "${PREVIOUS_SHA}" ]; then
  git checkout "${PREVIOUS_SHA}"
  export WHIS_IMAGE_TAG="${PREVIOUS_SHA}"
  ${COMPOSE} pull whis-worker
  ${COMPOSE} up -d whis-worker
fi
exit 1
```

#### C5 — Mudanças em `infra/docker-compose.yml`

```yaml
whis-worker:
  image: ghcr.io/bielvelozo/whis-worker:${WHIS_IMAGE_TAG:-latest}
  # build: removido daqui — vive em docker-compose.local.yml
  env_file: profile/.env
  init: true
  ports:
    - "3500-3505:3500-3505"
  healthcheck:
    test: ["CMD", "curl", "-fsS", "http://localhost:8080/health"]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 30s
  volumes: # idem ao atual
    ...
  restart: unless-stopped
  stdin_open: true
  tty: true
```

#### C6 — Novo `infra/docker-compose.local.yml` (override de dev)

Mantém `build:` pra dev local não depender de GHCR:

```yaml
services:
  whis-worker:
    build:
      context: .
      dockerfile: infra/Dockerfile
    image: whis-worker:dev
```

(Já existe um `docker-compose.local.yml` no repo per `git log` — vou verificar e estender em vez de sobrescrever.)

#### C7 — Mudanças em `infra/entrypoint.sh`

Adicionar bloco no topo:

```bash
# Validate .env has all keys from .env.example
if [ -f /app/profile/.env.example ] && [ -f /app/profile/.env ]; then
  MISSING=""
  while IFS='=' read -r key _; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    grep -q "^${key}=" /app/profile/.env || MISSING="${MISSING} ${key}"
  done < /app/profile/.env.example
  if [ -n "${MISSING}" ]; then
    echo "FATAL: profile/.env missing keys:${MISSING}" >&2
    exit 1
  fi
fi
```

#### C8 — Setup one-time na VM (documentado em `docs/specs/0005-cicd/setup.md`)

Não é entregável de código mas é parte da spec — sequência manual feita uma vez:

1. SSH na EC2 como user atual.
2. `sudo useradd -m -s /bin/bash whis-deploy && sudo usermod -aG docker whis-deploy`.
3. `sudo mkdir -p /opt/whis && sudo chown whis-deploy:whis-deploy /opt/whis`.
4. `sudo -u whis-deploy git clone git@github.com:bielvelozo/Whis-Agent.git /opt/whis`.
5. Copiar `profile/` (`.env`, `USER.md`, `config.yaml`) e `context/` da pasta atual pra `/opt/whis/`.
6. Gerar par SSH no laptop (`ssh-keygen -t ed25519 -f ~/.ssh/whis-deploy -C "whis-deploy@github-actions"`).
7. Adicionar pubkey em `/home/whis-deploy/.ssh/authorized_keys` na VM.
8. Gerar PAT do GitHub com escopo `read:packages` em `https://github.com/settings/tokens`.
9. Criar package GHCR com primeiro push manual (ou deixar primeiro deploy criar).
10. Em `Settings → Secrets and variables → Actions` do repo, criar: `EC2_HOST`, `EC2_USER=whis-deploy`, `EC2_SSH_KEY_B64` (private key em base64 single-line), `GHCR_PAT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`.
11. Confirmar SG da EC2 aceita 22 (já aceita pelo deploy manual atual — sem mudança).

### Data flow

Não aplicável — não há data model nesta spec. Apenas artefatos:

- **Imagem Docker** taggeada por SHA + `latest`, persistida em `ghcr.io/bielvelozo/whis-worker`.
- **Estado de deploy** em `/opt/whis/.last-deploy-sha` (texto puro, último SHA com healthcheck OK) — usado pra rollback.
- **Logs** ficam no `docker compose logs` (volume implícito do Docker), não há agregação central nesta spec.

### Error handling

| Falha | Onde detectada | Comportamento |
|---|---|---|
| Lint/typecheck/test falha | `gate` job | Workflow para; deploy não roda; PR fica vermelho. Sem notif Telegram (autor já recebe email do GitHub no caso de PR). |
| `docker buildx` falha | `build-and-push` job | Workflow para; sem push GHCR. Step `if: failure()` no job final notifica Telegram. |
| `docker push` 403 | `build-and-push` job | Idem. Causa mais comum: package GHCR não tem repo `Whis-Agent` em `Manage Actions access` (resolução manual no setup). |
| SSH conexão falha | `deploy` job | `appleboy/ssh-action` retorna erro; step `if: failure()` notifica Telegram com link pro run. |
| `git pull` na VM falha (conflito) | `deploy.sh` step 1 | `set -e` para o script com exit ≠ 0; SSH retorna erro; notif Telegram. **Causa esperada:** alguém mexeu em `/opt/whis` à mão. Resolução: SSH manual, `git stash` ou `git reset --hard`. |
| `docker pull` 401 | `deploy.sh` step 4 | `set -e` mata script. **Causa esperada:** PAT GHCR expirado. Renovar PAT, atualizar secret, re-disparar deploy. |
| Container sobe mas healthcheck falha | `deploy.sh` step 5 (loop 30×2s = 60s timeout) | Auto-rollback pro SHA anterior; `set -e` mata script com exit 1; notif Telegram informando "deployed → rolled back". |
| Healthcheck falha **sem PREVIOUS_SHA** (primeiro deploy) | `deploy.sh` step 6 | Sem rollback; `exit 1`; container continua rodando o que estiver lá; notif Telegram "first deploy failed". |
| `.env` drift (chave nova faltando na VM) | `entrypoint.sh` no boot do container novo | Container exit 1; `restart: unless-stopped` reinicia em loop; healthcheck falha; auto-rollback dispara. Notif Telegram com mensagem genérica. **Resolução:** SSH, atualizar `.env`, re-disparar deploy. |
| Telegram notif falha | step `if: failure()` | Step propaga erro mas o run já estava em failure — visível no Actions UI. Sem cascata. |

### Testing

Testes automatizados são **fora de escopo** dessa spec — o pipeline em si é uma vez "configurado e deixa rodando". Validação por dry-run manual:

1. **`ci.yml` em PR:** abrir PR de teste com mudança trivial (typo em README). Confirmar gate roda + passa.
2. **`ci.yml` em PR com erro:** PR com erro de typecheck proposital. Confirmar gate falha.
3. **`deploy.yml` happy path:** merge de PR pequeno em `main`. Confirmar imagem aparece em GHCR; `/opt/whis/.last-deploy-sha` atualiza; `docker compose ps` mostra container com tag nova; healthcheck OK.
4. **`deploy.yml` rollback:** introduzir bug que faz `/health` retornar 500 (`throw` proposital no handler). Confirmar auto-rollback volta pro SHA anterior; Telegram recebe notif.
5. **`rollback.yml` manual:** dispatch manual com SHA conhecido bom. Confirmar volta pra ele.
6. **`.env` drift:** adicionar var nova em `.env.example`, push. Confirmar container falha no boot com mensagem clara; auto-rollback dispara.

Os testes do worker (`pnpm run test`) continuam rodando no `gate` job — cobertura existente está preservada.

## Risks

1. **PAT do GHCR expira.** Máximo 1 ano. Quando expirar, deploy falha em `docker pull`. Mitigação: documentar em `setup.md`. Calendário/lembrete fica fora desta spec — pode virar `/schedule` futuro.
2. **Chave SSH `EC2_SSH_KEY_B64` vaza.** Acesso completo ao user `whis-deploy` (que está em `docker` group → root efetivo na VM). Mitigação: chave dedicada (não a do Gabriel pessoal); rotação trivial (gerar nova, atualizar `authorized_keys` + secret). User dedicado limita blast — mas não a zero.
3. **GitHub Actions runners ficam fora do ar.** Deploy bloqueado até voltarem. Mitigação: Gabriel ainda pode fazer SSH manual + `bash deploy.sh <sha>` (script é stand-alone). Documentar em `setup.md`.
4. **Rollback automático mascara problema real.** Bug que só aparece sob carga real pode passar healthcheck e quebrar depois (sem auto-rollback). Mitigação aceita: notif Telegram + `rollback.yml` manual cobrem o caso. Não há monitoramento contínuo nesta spec.
5. **Compose `restart: unless-stopped` em loop com `.env` quebrado** consome CPU/IO da VM até alguém intervir. Mitigação: `entrypoint.sh` valida env e exit limpo; healthcheck do compose marca `unhealthy`. Em t3.small, custo de container reiniciando é baixo (~50MB RAM enquanto bootando).
6. **GHCR rate limit** em pulls (anônimo: 10/h; autenticado: muito alto). Mitigação: pull autenticado via PAT — limite efetivo nunca atingido em uso normal.
7. **Discrepância entre SHA do código (git) e SHA da imagem (Docker)** se script falhar entre `git checkout` e `compose pull`. Estado: agent/ atualizado mas container ainda na imagem antiga. Mitigação: ordem do script é `git checkout` antes; se `docker pull` falhar, `set -e` mata; auto-rollback não reverte git porque `git checkout PREVIOUS_SHA` é chamado. **Ainda assim, se rollback também falhar parcialmente**, intervenção manual via SSH.
8. **PR de Dependabot tocando em `package.json`** dispara `ci.yml` mas não tem permissão pra ler secrets — gate roda OK. Sem deploy (não é push em main). Sem risco real. Documentado pra clareza.

## Acceptance criteria

A spec está **shipped** quando:

1. ✅ `.github/workflows/ci.yml` existe e dispara em PRs + push main; passa hoje em `main`.
2. ✅ `.github/workflows/deploy.yml` existe e foi executado com sucesso pelo menos uma vez em push real em `main`.
3. ✅ `.github/workflows/rollback.yml` existe e foi testado uma vez via `workflow_dispatch` com SHA conhecido.
4. ✅ `infra/deploy.sh` existe, é executável, e está em `/opt/whis/infra/deploy.sh` na VM.
5. ✅ `infra/docker-compose.yml` aponta `image: ghcr.io/bielvelozo/whis-worker:${WHIS_IMAGE_TAG:-latest}` e tem bloco `healthcheck:` no `whis-worker`.
6. ✅ `infra/entrypoint.sh` valida chaves de `.env` vs `.env.example` e aborta com mensagem clara em drift.
7. ✅ Imagens existem em `ghcr.io/bielvelozo/whis-worker` taggeadas por SHA + `latest`.
8. ✅ Os 6 secrets do C8 step 10 estão configurados no repo.
9. ✅ Deploy de teste com bug em `/health` dispara auto-rollback e mensagem Telegram chega no chat do Gabriel.
10. ✅ `docs/specs/0005-cicd/setup.md` documenta os 11 passos do C8.
11. ✅ Quality gate (`pnpm run quality-gate`) continua verde.
