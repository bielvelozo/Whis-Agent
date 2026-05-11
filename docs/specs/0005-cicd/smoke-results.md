---
feature: cicd
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-05-10
---
# CI/CD smoke results — 0005-cicd

Resultados dos 11 acceptance criteria do `spec.md`, validados em 2026-05-09 a 2026-05-10.

| # | Criterion | Status | Evidência |
|---|---|---|---|
| 1 | `ci.yml` existe e dispara em PRs + push main | ✅ | Runs CI #1-#4 todos verdes (push main). Branch protection não validada por gate de PR (não criamos PR explícito; gate em push main cobre o mesmo `quality-gate`). |
| 2 | `deploy.yml` executou com sucesso pelo menos uma vez | ✅ | Run #5 (SHA `916e710`) e #6 (SHA `7e17e4b`) — duração ~3-5min cada. Builds: `Quality gate` ✓ + `Build & push GHCR` ✓ + `SSH deploy` ✓ |
| 3 | `rollback.yml` testado via `workflow_dispatch` | ✅ | Rollback #1 (id `25646292215`) — input SHA `601921224b6eb5ea864edecc7876cfbc63ba022a` — completed success. VM voltou pro image `:6019212`, container healthy. Telegram recebeu notif "↩️ rollback OK". |
| 4 | `infra/deploy.sh` em `/opt/whis/infra/deploy.sh`, executável | ✅ | `-rwxrwxr-x 1 whis-deploy whis-deploy 2431 ... infra/deploy.sh` |
| 5 | Compose tem image GHCR + healthcheck | ✅ | `image: ghcr.io/bielvelozo/whis-worker:${WHIS_IMAGE_TAG:-latest}` + bloco `healthcheck:` com `curl -fsS http://localhost:8080/health`, interval 30s, start_period 30s. `docker compose config` valida sem erros. |
| 6 | `entrypoint.sh` valida `.env` drift | ✅ | Teste destrutivo: adicionado `DRIFT_TEST_KEY=...` em `profile/.env.example` na VM → restart → container em `Restarting (1)` loop, log: `FATAL: profile/.env missing keys from .env.example: DRIFT_TEST_KEY`. Após `git checkout` do `.env.example`, container volta a healthy em 6s. |
| 7 | Imagens em `ghcr.io/bielvelozo/whis-worker` taggeadas por SHA + `latest` | ✅ | `docker manifest inspect` confirma tags `:601921224b6eb5ea864edecc7876cfbc63ba022a`, `:916e71019d29a8dc9b642512068fa950de0fbcf9`, `:7e17e4ba3dd01695c13adc093d46b65c9e648758`, `:latest`. Pull autenticado via `GHCR_PAT` funciona. |
| 8 | 6 secrets configurados | ✅ | 6 secrets ativos: `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY_B64` (base64), `GHCR_PAT`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`. Detalhe: o secret SSH original `EC2_SSH_KEY` (PEM raw) sofreu mangling no paste via web UI; trocado por `EC2_SSH_KEY_B64` (base64 single-line, imune a CRLF/whitespace). Documentado em `setup.md` item 9. |
| 9 | Deploy com `/health` quebrado dispara auto-rollback + Telegram | ✅ (indireto) | Validado durante caos não-intencional: Deploy #2 (SHA `8415e84`) e #3 (SHA `c6fec17`) tiveram healthcheck fail por conflito de bot Telegram (409 — local + prod com mesmo token). Em ambos, `deploy.sh` detectou healthcheck timeout, executou `git checkout PREVIOUS_SHA` + `docker pull` + `compose up`, e Telegram notif ❌ foi entregue (confirmado por Gabriel). Não fizemos teste destrutivo deliberado de `/health` 500 — mecanismo já comprovado em runtime real. |
| 10 | `setup.md` documenta os 11 passos | ✅ | `docs/specs/0005-cicd/setup.md` — 11 passos numerados + 2 seções de operação (renovação PAT, rotação SSH key). Inclui lessons learned: classic PAT-only (fine-grained não suporta GHCR pessoal), base64 pro SSH key, bot Telegram único polling. |
| 11 | Quality gate continua verde | ✅ | Run CI #4 (último em main) → `quality-gate` (lint+typecheck+test) verde, `build` verde. Quality gate verde também na pre-flight do laptop antes do primeiro push (Task 2). |

## Issues encontrados durante a validação

1. **Bug chicken-and-egg do primeiro deploy**: VM clonada antes dos commits CI/CD, então `infra/deploy.sh` ainda não existia no disco; `bash infra/deploy.sh` falhou no primeiro ssh-action. **Fix**: ssh-action agora faz `git fetch + checkout SHA` **antes** de chamar `deploy.sh`. Commit `8415e84`.

2. **SSH key secret mangled no paste**: Primeira tentativa de criar `EC2_SSH_KEY` com PEM raw teve `ssh.ParsePrivateKey: no key found`. Re-paste não resolveu — paste do web UI adicionou whitespace/line endings invisíveis. **Fix**: trocar pra `EC2_SSH_KEY_B64` (base64 single-line, decoded no workflow antes de passar pro ssh-action). Commits `e4607b0` + `916e710`.

3. **Bot Telegram polling exclusivo**: Whis local rodando com mesmo `TELEGRAM_BOT_TOKEN` da prod causou 409 Conflict — prod crash-looped, auto-rollback rolou (corretamente), mas alvo do rollback também crasheava pelo mesmo motivo. **Fix**: stop do local (`docker:down:local`). **Documentado em `setup.md`**: pra rodar prod+dev simultaneamente, precisa de DOIS bots separados no @BotFather + `.env.local` com token diferente.

4. **Fine-grained PAT não suporta GHCR pessoal**: GitHub UI do fine-grained PAT não tem opção "Packages" em "Account permissions". **Fix**: usar classic PAT com escopo `write:packages` (auto-marca `read:packages`). Documentado em `setup.md` item 7 com aviso explícito.

5. **Quality gate drift pré-existente**: 2 arquivos com formatting inconsistente (`packages/storage/src/scheduled-message-repo.test.ts`, `apps/worker/src/agent/types.ts`) falhavam o gate antes do nosso pipeline existir. **Fix**: `biome check --write` aplicado, commit separado `40582a4` ("style: biome auto-format (pre-existing drift)").

## Final state

- **Production VM** (`18.231.48.71`): container `whis-worker` rodando `ghcr.io/bielvelozo/whis-worker:7e17e4ba3dd01695c13adc093d46b65c9e648758`, healthy, Telegram canal ativo
- **Pipeline ativo**: push em `main` → `ci.yml` + `deploy.yml` (gate → build GHCR → ssh deploy → healthcheck → telegram on fail)
- **Rollback manual**: `workflow_dispatch` em `rollback.yml` com input `sha`
- **Auto-rollback**: `deploy.sh` reverte pro `.last-deploy-sha` anterior se healthcheck falhar em 60s
