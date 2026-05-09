---
feature: cicd
spec: "[[spec]]"
created: 2026-05-08
---
# CI/CD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (recomendado pra esta plan, 7 tasks pequenas e focadas) ou `superpowers:subagent-driven-development` se preferir isolar cada workflow num subagente. Steps em `[[tasks]]` usam checkbox `- [ ]` pra tracking.

**Goal:** Automatizar o deploy do Whis com GitHub Actions: 3 workflows (`ci.yml`, `deploy.yml`, `rollback.yml`) + script `infra/deploy.sh` idempotente na VM + ajustes em `docker-compose.yml`/`entrypoint.sh` + doc de setup one-time. Trigger em push `main`, build em runners do GitHub, push em GHCR taggeado por SHA, SSH na EC2 pra `git pull` + `docker pull` + `compose up` + healthcheck `/health` + auto-rollback. Falha notifica Telegram via bot do Whis.

**Architecture:** Pipeline em duas etapas separadas (gate em PR, deploy em main) com 3 workflows GitHub Actions, mais 1 script shell na VM que centraliza a lógica de deploy/rollback (reutilizado por `deploy.yml` e `rollback.yml`). Imagem versionada por commit SHA em GHCR (privado, pull autenticado via PAT). Healthcheck via `curl -fsS http://localhost:8080/health` (endpoint Hono já existente em `apps/worker/src/webhook/server.ts:33`). Bind mounts `./agent` continuam vivos — script faz `git checkout SHA` antes do `docker pull` pra manter código TS e skills no mesmo SHA.

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`, `docker/build-push-action@v6`, `appleboy/ssh-action@v1`). GitHub Container Registry (`ghcr.io/bielvelozo/whis-worker`). Bash 5+ na VM. Docker Compose v2 já instalado. Telegram Bot API via `curl`. **Sem dependências runtime novas no app** — pipeline é puramente infra.

---

## Approach

A spec é deliberadamente conservadora — não muda runtime, não adiciona ambientes, não migra pra ECS. O trabalho real está em escrever YAML correto + script shell idempotente + documentar o setup one-time da VM. Por isso o plan tem **7 tasks pequenas**, não 15+.

A primeira task é **Task 0: Pre-flight checks** — validar fatos que a spec assume mas que valem confirmar antes (formato exato do output do `/health`, presença de `curl` no runtime do container pra `compose healthcheck` funcionar dentro do container, etc.). Sem discovery aqui não é catastrófico mas economiza retrabalho.

A segunda task entrega **`setup.md` na frente** dos workflows porque o setup da EC2 é feito manualmente pelo Gabriel e pode correr em paralelo com a escrita dos workflows. Quando os workflows ficarem prontos, o setup já pode estar concluído.

Tasks 2-6 entregam uma peça por commit — `compose+entrypoint`, `deploy.sh`, `ci.yml`, `deploy.yml`, `rollback.yml`. Cada uma é independentemente revisável.

Task 7 é **smoke real** seguindo os 11 acceptance criteria da spec. Inclui um teste destrutivo proposital (bug em `/health` pra disparar auto-rollback). Não é "rodar e deu" — é checklist com evidência por item.

**TDD oportunidades** são limitadas (a maior parte é config), mas existem onde fazem sentido:

- `shellcheck infra/deploy.sh` antes de commit (lint shell — captura quoting, unset vars, etc.).
- `actionlint .github/workflows/*.yml` quando disponível (lint específico de Actions YAML — captura ref errado, secret name typo, etc.). Usa o container `rhysd/actionlint:latest` se actionlint não tiver instalado local.
- `docker compose -f infra/docker-compose.yml --project-directory . config` valida o YAML do compose após cada edit.
- `entrypoint.sh` ganha uma checagem de drift `.env` que dá pra exercitar manualmente: editar `.env` faltando uma chave de `.env.example`, rebuild, ver mensagem clara.

A constraint de não conseguir rodar GitHub Actions sem push real significa que `ci.yml` e `deploy.yml` só são validados de fato no Task 7 (smoke). Pré-validação local via `actionlint` reduz iterações.

## Architecture

```
                   GitHub repo (bielvelozo/Whis-Agent)
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
        ┌──────────┐         ┌──────────┐         ┌──────────────┐
        │  ci.yml  │         │deploy.yml│         │ rollback.yml │
        │ PR + push│         │push main │         │ workflow_    │
        │  gate    │         │ + build  │         │ dispatch     │
        │  + build │         │ + push   │         │ (input: sha) │
        │          │         │ + ssh    │         │              │
        └──────────┘         └─────┬────┘         └──────┬───────┘
                                   │ ssh                 │ ssh
                                   ▼                     ▼
                        ┌──────────────────────────────────────┐
                        │  EC2 — /opt/whis (user: whis-deploy) │
                        │                                      │
                        │   bash infra/deploy.sh ${SHA}        │
                        │   (mesmo script, both workflows)     │
                        │                                      │
                        │   1. git fetch + checkout SHA        │
                        │   2. docker login ghcr.io            │
                        │   3. read .last-deploy-sha           │
                        │   4. WHIS_IMAGE_TAG=$SHA pull        │
                        │   5. compose up -d                   │
                        │   6. healthcheck /health (60s tmout) │
                        │   7. on success: write state file    │
                        │      on failure: rollback + exit 1   │
                        │                                      │
                        │  GHCR: ghcr.io/bielvelozo/           │
                        │        whis-worker:${SHA}, :latest   │
                        └──────────────────────────────────────┘
                                   │ on failure
                                   ▼
                        ┌──────────────────────────────────────┐
                        │  Telegram Bot API                    │
                        │  bot${TELEGRAM_BOT_TOKEN}/sendMessage│
                        │  chat_id=${OWNER_CHAT_ID}            │
                        └──────────────────────────────────────┘
```

**Component responsibilities:**

- **`.github/workflows/ci.yml`** — gate-only workflow. Roda em PRs (target `main`) e push em `main`. Não builda imagem Docker. Não deploya. Single job: checkout + setup pnpm + setup node + install + quality-gate + build. Concurrency `cancel-in-progress: true` (PRs podem ser cancelados sem dó). **Novo.**

- **`.github/workflows/deploy.yml`** — pipeline completo. Trigger só em push `main`. Três jobs sequenciais: `gate` (idêntico a ci.yml), `build-and-push` (Docker buildx + push GHCR), `deploy` (SSH + telegram on failure). Concurrency `deploy-prod` com `cancel-in-progress: false`. **Novo.**

- **`.github/workflows/rollback.yml`** — workflow_dispatch manual. Input `sha`. Single job que faz SSH e roda `bash deploy.sh ${sha}`. Mesmo concurrency group `deploy-prod`. **Novo.**

- **`infra/deploy.sh`** — script shell idempotente. Recebe SHA como `$1`. Lê `GHCR_TOKEN` da env. Faz `git fetch+checkout`, login GHCR, salva PREVIOUS_SHA antes do swap, pull+up, healthcheck loop (30 tentativas × 2s = 60s max), auto-rollback se healthcheck falhar. Vive em `/opt/whis/infra/deploy.sh` na VM (chega lá via `git pull` no próprio script). **Novo.**

- **`infra/docker-compose.yml`** — duas mudanças cirúrgicas:
  - Linha 38 (`image: whis-worker:dev`): trocar pra `image: ghcr.io/bielvelozo/whis-worker:${WHIS_IMAGE_TAG:-latest}`.
  - Remover bloco `build:` (linhas 35-37) — migra pra `docker-compose.local.yml`.
  - Adicionar bloco `healthcheck:` no service `whis-worker` (test via `curl /health`).
  **Modificado.**

- **`infra/docker-compose.local.yml`** — receber o `build:` que saiu do compose principal pra dev local continuar funcionando (`pnpm run docker:up:local` rebuilda imagem `whis-worker:dev` no host). Já existe (commit `cd4ebd9`); só estender. **Modificado.**

- **`infra/entrypoint.sh`** — adicionar bloco no topo (antes do `set -eu`) que valida chaves de `profile/.env` vs `profile/.env.example` e aborta com mensagem clara em caso de drift. **Modificado.**

- **`docs/specs/0005-cicd/setup.md`** — guia manual one-time pra Gabriel: criar user `whis-deploy`, clonar repo em `/opt/whis`, copiar `profile/` e `context/`, gerar par SSH dedicado, criar PAT GHCR, configurar 6 secrets do repo. 11 passos numerados. **Novo.**

- **`docs/specs/0005-cicd/smoke-results.md`** — resultados do Task 7 (1 linha por acceptance criterion). **Novo.**

**Sem mudança em:**

- `apps/worker/src/webhook/server.ts` — `/health` já existe.
- `package.json` — sem deps novas.
- `agent/`, `profile/`, `context/` — sem mudança.
- `Dockerfile` — sem mudança (já tem `curl` instalado pro healthcheck).

## Tech Stack

- **Runtime:** GitHub Actions (`ubuntu-latest` runners). Sem self-hosted.
- **Action versions** (pin major; deixar minor/patch flutuar):
  - `actions/checkout@v4`
  - `pnpm/action-setup@v4`
  - `actions/setup-node@v4` (`node-version: 24`, `cache: 'pnpm'`)
  - `docker/setup-buildx-action@v3`
  - `docker/login-action@v3`
  - `docker/build-push-action@v6` (com `cache-from/to: type=gha`)
  - `appleboy/ssh-action@v1`
- **Registry:** `ghcr.io/bielvelozo/whis-worker`. Privado. Push via `${{ secrets.GITHUB_TOKEN }}` automático. Pull via PAT (`GHCR_PAT`).
- **Healthcheck endpoint:** `GET http://localhost:8080/health` (já existe).
- **Telegram notif:** `curl` step com `https://api.telegram.org/bot${TOKEN}/sendMessage`.
- **VM:** Ubuntu/Amazon Linux 2 com Docker Compose v2. Bash 5+.
- **Lints locais:** `shellcheck` (Windows: via `scoop install shellcheck` ou container Docker `koalaman/shellcheck:stable`). `actionlint` (via container `rhysd/actionlint:latest`).

## File Structure

🆕 = novo, 🔧 = modificado, ✅ = não muda.

**Root:**
- `.github/workflows/ci.yml` 🆕
- `.github/workflows/deploy.yml` 🆕
- `.github/workflows/rollback.yml` 🆕

**`infra/`:**
- `deploy.sh` 🆕
- `docker-compose.yml` 🔧 (image, healthcheck, build movido)
- `docker-compose.local.yml` 🔧 (recebe build)
- `entrypoint.sh` 🔧 (env drift check)
- `Dockerfile` ✅
- `setup-evolution.sh` ✅
- `setup-telegram.ts` ✅

**`docs/specs/0005-cicd/`:**
- `spec.md` ✅ (commit `2ad2908`)
- `plan.md` 🆕 (este arquivo)
- `tasks.md` 🆕
- `setup.md` 🆕 (guia manual EC2)
- `smoke-results.md` 🆕 (resultados Task 7)

**Repo (config):**
- `Settings → Secrets and variables → Actions` 🔧 (manual, no GitHub UI):
  - `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`, `GHCR_PAT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`

**EC2 (manual, parte do setup.md):**
- `/opt/whis/` 🆕 (clone do repo, owned by `whis-deploy`)
- `/home/whis-deploy/.ssh/authorized_keys` 🔧 (pubkey do par dedicado)
- `whis-deploy` user + grupo `docker` 🆕

## Phase Ordering

7 phases. Cada phase termina em commit (exceto Phase 0 que é só leitura).

**Phase 0 — Pre-flight (Task 0):** Confirmar fatos que a spec assume. Sem commit.

**Phase 1 — Setup doc na frente (Task 1):** Escrever `setup.md` cedo pra Gabriel poder rodar os passos manuais da EC2 em paralelo com as próximas tasks. **Não bloqueia** progresso das próximas — escrita do código não depende do setup estar feito.

**Phase 2 — Compose + entrypoint (Task 2):** Mudar `docker-compose.yml`, `docker-compose.local.yml`, `entrypoint.sh`. Validar com `docker compose config` e build local. Esta phase é segura: dev local continua funcionando, prod ainda não usa GHCR.

**Phase 3 — Deploy script (Task 3):** Escrever `infra/deploy.sh`. Validar com `shellcheck`. Não roda ainda — só quando Task 4+ existir e Phase 7 disparar.

**Phase 4 — ci.yml (Task 4):** Escrever workflow de gate. Validar com `actionlint`. Pode ser commitado e PR aberto pra ver gate rodar (smoke parcial).

**Phase 5 — deploy.yml (Task 5):** Workflow de deploy. Validar com `actionlint`. Não dispara até estar em `main`.

**Phase 6 — rollback.yml (Task 6):** Workflow manual de rollback. Reusa `deploy.sh`, é só wiring.

**Phase 7 — Smoke real (Task 7):** Disparar deploy real, validar 11 acceptance criteria, registrar em `smoke-results.md`. Inclui teste destrutivo (bug em `/health` proposital). **Pré-requisito:** Phase 1 (setup) concluída pelo Gabriel na EC2.

Ordem racional: doc de setup primeiro (paraleliza), depois código local (compose + entrypoint), depois infra do CI (script + workflows), depois validação real.

## Risks & Open Questions

**Resolved before this plan:**
- ✅ `/health` existe em `apps/worker/src/webhook/server.ts:33`.
- ✅ `curl` está no runtime do container (Dockerfile linha 5-7).
- ✅ `docker-compose.local.yml` já existe (commit `cd4ebd9`); só estender.
- ✅ Username GitHub: `bielvelozo`.

**Open questions** (sem bloqueio, mas Task 0 confirma):
- Output exato do `/health` em estado degradado (`{ status: 'degraded' }` retorna 200 ou non-200?). Se sempre 200, healthcheck do compose precisa de filtro adicional além de `-f` (que só falha em HTTP ≠ 2xx).
- Se a EC2 está em Ubuntu ou Amazon Linux 2 (afeta comandos no `setup.md`).
- Se há firewall do GitHub Actions IPs além do SG (raríssimo em EC2 default).

**Risks during implementation:**
- **`actionlint` requer Docker.** Em Windows + Docker Desktop, rodar via container está OK. Sem actionlint, `ci.yml` errado só é detectado no primeiro push real. Mitigação: ler atentamente + comparar com workflows oficiais do `pnpm`/`docker/build-push-action`.
- **Primeiro `docker push` no GHCR pode falhar 403** se package não tem repo `Whis-Agent` em `Manage Actions access`. Documentado em `setup.md`.
- **`appleboy/ssh-action` strict-host-key-checking.** Default é `no` (acepta qualquer fingerprint). Manter assim — alternativa é incluir `EC2_HOST_KEYSCAN` como secret e isso é overkill pro caso.
- **Auto-rollback em primeiro deploy** — não há `PREVIOUS_SHA`. Script trata isso (skipa rollback se `PREVIOUS_SHA` vazio) mas vale validar no smoke.
