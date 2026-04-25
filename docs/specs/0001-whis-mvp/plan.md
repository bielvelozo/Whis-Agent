---
feature: whis-mvp
spec: "[[spec]]"
created: 2026-04-24
---
# Whis MVP — Implementation Plan

> **For agentic workers:** Use a subagent-driven loop or inline execution to implement this plan task-by-task. Steps in `[[tasks]]` use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir e entregar o MVP descrito em `[[spec]]` — um processo Node/TS Dockerizado que recebe DMs no WhatsApp do Gabriel via Evolution API, roteia pelo Claude Code (autenticado por OAuth), e responde de volta no WhatsApp, com a skill `hello-world` validando o pipeline ponta-a-ponta.

**Architecture:** Ports & adapters herdado do `zeno-agent`. Duas interfaces — `Channel` (fontes de mensagem) e `AgentBackend` (motores de raciocínio) — definidas primeiro; uma implementação de cada (`WhatsAppChannel` + `ClaudeCodeBackend`) costurada por um `AgentCore` orquestrador. Memória durável fora do código: vault Obsidian em `context/`. Memória curta: `SessionRepo` SQLite com janela rotativa de 6h. Observabilidade: pino estruturado em stdout.

**Tech Stack:** TypeScript strict + Node 24 LTS, pnpm 10 + Turborepo, Hono (webhook), `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `pino`, `zod`, Vitest, Biome, Knip. Container `node:24-slim` user `node`. 2 containers via Docker Compose: `evolution-api` (`evoapicloud/evolution-api:v2.3.7`) + `whis-worker`.

---

## Approach

A implementação herda **literalmente** as peças bem-formadas do projeto-base `zeno-agent` (clonado em `C:\Users\gabri\AppData\Local\Temp\zeno-agent` pra consulta) e troca **três eixos**: (1) canal Slack → WhatsApp via Evolution API com webhook server Hono embutido; (2) `cwd` do backend Claude apontando pro vault Obsidian (`context/`) em vez de `/workspace`; (3) escopo cortado — apenas `apps/worker`, sem `apps/api`, `apps/dashboard`, GitHub App, guardrails, ou cron runner. A diferença em `AgentCore` é mínima (apenas remoção de `react('white_check_mark')`/`react('warning')` pós-resposta, conforme preferência do Gabriel — a mensagem de resposta já sinaliza sucesso/erro).

A divisão entre **arquivos novos** (escritos do zero seguindo TDD ruthless) e **arquivos herdados 1:1** (copiados do Zeno e adaptados em paths/imports) está explícita na seção File Structure. Pra arquivos herdados, os tasks são "copy → adapt imports `@zeno/` → `@whis/` → run typecheck/tests". Pra novos, ciclo TDD completo (failing test → implementation → green → commit). Mesmos princípios em ambos: DRY, YAGNI, frequent commits.

A primeira tarefa do plano é **Task 0: Discovery**, um checkpoint não-código que valida em abril/2026 as versões e contratos atuais de Evolution API, Claude Agent SDK, Hono, better-sqlite3, Node LTS, e imagem Evolution Docker. O conhecimento do Claude (cutoff janeiro/2026) tem 3 meses de drift; qualquer mudança material é capturada e, se significativa, dispara revisão da spec antes de o código começar. Achados ficam em `docs/specs/0001-whis-mvp/discovery-notes.md` (escopo desse spec — diferente do Zeno que usa um vault de learnings global, que aqui se confunde com o vault Obsidian do usuário).

Persistência mínima: dois volumes nomeados (`whis_data` pro SQLite, `claude_home` pro `~/.claude` da CLI) e dois bind mounts (`./context` RW pro vault, `./agent` + `./profile` RO). A Evolution roda em container vizinho com volumes próprios (`evolution_instances`, `evolution_store`). Webhooks são internos à rede do compose (`http://whis-worker:8080/webhook/whatsapp`); zero exposição externa. Painel da Evolution é exposto em `localhost:8081` apenas pro pareamento via QR code.

## Architecture

```
                                          docker network interno
┌──────────────┐      ┌─────────────────┐    ┌──────────────────────┐
│  você (chip) │──WA──│  evolution-api  │───▶│     whis-worker      │
└──────────────┘      │                 │    │                      │
                      │ - WhatsApp Web  │    │ Hono :8080           │
                      │ - REST :8080    │    │   /webhook/whatsapp  │
                      │ - Webhook out   │◀───│   /health            │
                      └─────────────────┘    │                      │
                         ▲                   │ WhatsAppChannel      │
                         │  POST sendText    │  (adapter Evolution) │
                         └───────────────────│   │                  │
                                             │   ▼                  │
                                             │ AgentCore            │
                                             │  (channel↔backend)   │
                                             │  + SessionRepo (6h)  │
                                             │  + MessageRepo       │
                                             │   │                  │
                                             │   ▼                  │
                                             │ ClaudeCodeBackend    │
                                             │  (claude-agent-sdk)  │
                                             │  cwd=/app/context    │
                                             └──┬───────────────────┘
                                                │
                                                ▼
                                    [ vault Obsidian (context/) ]
                                    [ sqlite: /app/data/whis.db ]
```

**Component responsibilities:**

- **`Channel`** (port, `apps/worker/src/channels/types.ts`) — define `start`, `send`, `react`, `unreact`, `waitForReaction`, `openDm`, `stop` + tipos `IncomingMessage` / `MessageTarget` / `Attachment` / `ReactionEvent`. Não conhece plataforma específica. Herdado 1:1 do Zeno.
- **`WhatsAppChannel`** (`apps/worker/src/channels/whatsapp/adapter.ts`) — implementa `Channel` via Evolution API. Recebe mensagens via webhook (handler registrado pelo `start()`, invocado pelo `webhook/server.ts`). Envia via REST. `react/unreact` mapeia nome (`eyes`) → emoji (👀) → POST `/chat/sendReaction`. `waitForReaction` é no-op (retorna null). `openDm(userId)` retorna `userId`. **Novo arquivo (escrito do zero).**
- **`evolution-client.ts`** (`apps/worker/src/channels/whatsapp/evolution-client.ts`) — wrapper tipado em `fetch` pra REST da Evolution. Métodos: `sendText`, `sendReaction`, `removeReaction`, `ping`. Header `apikey` via env. **Novo.**
- **`normalize.ts`** (`apps/worker/src/channels/whatsapp/normalize.ts`) — converte payload `messages.upsert` em `IncomingMessage`. `remoteJid` → `userId`/`conversationId`, `key.id` → `messageRef`, `threadId: null`. Whitelist por `WHATSAPP_OWNER_NUMBER`. **Novo.**
- **`format.ts`** (`apps/worker/src/channels/whatsapp/format.ts`) — traduz markdown do Claude pra sintaxe WhatsApp (`**bold**` → `*bold*`, `*italic*` → `_italic_`, code fences mantidos curtos). **Novo.**
- **`webhook/server.ts`** (`apps/worker/src/webhook/server.ts`) — Hono app. `POST /webhook/whatsapp`: parse → normalize → invoca handler do `WhatsAppChannel`. `GET /health`: `{ status, dbOpen, evolutionPing }`. Porta 8080 interna. **Novo.**
- **`AgentBackend`** (port, `apps/worker/src/agent/types.ts`) — define `query(input): Promise<output>`. Tipos `AgentInput` / `AgentOutput` / `AgentBackendError` (`auth_expired`, `rate_limited`, `timeout`, `unknown`). Herdado 1:1.
- **`ClaudeCodeBackend`** (`apps/worker/src/agent/backends/claude-code.ts`) — implementa `AgentBackend` chamando `query()` do `@anthropic-ai/claude-agent-sdk` in-process. `allowedTools: ['Bash','Read','Glob','Grep']`. `permissionMode: 'bypassPermissions'`. Classifica erros conhecidos (auth, rate limit, timeout). Herdado 1:1.
- **`MockBackend`** (`apps/worker/src/agent/backends/mock.ts`) — implementação pra dev/tests sem custo de tokens. Match por regex em `userMessage`. Herdado 1:1 do Zeno (template + fixtures).
- **`AgentCore`** (`apps/worker/src/agent/core.ts`) — costura `Channel` ↔ `AgentBackend`. Janela rotativa de 6h via `SessionRepo`. Reactions (`eyes` on/off). Tradução de erros via `translateError()`. **Adaptado do Zeno** (3 mudanças: remove `react('white_check_mark')`/`react('warning')`; substitui `wrapWithSlackContext` por `wrapWithWhatsAppContext`; usa `chatId` como chave de sessão em vez de `threadId`).
- **`system-prompt.ts`** (`apps/worker/src/agent/system-prompt.ts`) — carrega SOUL.md (de `agent/`) + USER.md (de `profile/`) + always-active skills (de `agent/skills/` e `profile/skills/`). Herdado 1:1 (paths já são `/app/agent` + `/app/profile`).
- **`mcp.ts`** (`apps/worker/src/agent/mcp.ts`) — merge de `agent/mcp.json` + `profile/mcp.json` com interpolação `${VAR}` e override por profile. Herdado 1:1.
- **`profile/watcher.ts`** (`apps/worker/src/profile/watcher.ts`) — `ProfileWatcher` com `fs.watch` recursivo + debounce 250ms pra hot-reload de SOUL.md, USER.md, mcp.json. Herdado 1:1.
- **`config.ts`** (`apps/worker/src/config.ts`) — Zod schema das env vars. Falha rápido em boot. **Novo** (schema diferente do Zeno: WhatsApp/Evolution em vez de Slack/GitHub).
- **`index.ts`** (`apps/worker/src/index.ts`) — composition root. Bootstrap: `loadConfig` → `openDatabase` → `runMigrations` → `loadAgentFile/loadProfileFile/loadAlwaysActiveSkills` → `loadMcpConfig` → `EvolutionClient.ping()` → `WhatsAppChannel.start()` → `webhookServer.listen()` → `ProfileWatcher.start()` → log `whis_online`. Graceful shutdown (SIGINT/SIGTERM). **Novo, derivado do `index.ts` do Zeno menos guardrails/cron/commands/api.**
- **`packages/storage/`** — better-sqlite3 wrappers. `db.ts` (open/close/runMigrations, WAL mode). `session-repo.ts` (`SessionRepo`: get/upsert/delete; record `lastMessageAt`). `message-repo.ts` (`MessageRepo`: insert/recent). `migrations/001_initial.sql`. **Novo** (Zeno tem mais repos; aqui só 2).
- **`packages/logger/`** — pino factory `createLogger({ service })`. Sem `dbSink` (não tenho `LogRepo` no MVP). **Subset do Zeno.**
- **`agent/SOUL.md`** — identidade do Whis em PT-BR. Estrutura: quem é (Whis de DBZ), skills, vault, modos cognitivos (work/personal), tom, regras de segurança. **Novo.**
- **`agent/skills/hello-world/SKILL.md`** — primeira skill, valida pipeline. Cumprimenta o Gabriel pelo nome. Não escreve no vault. **Novo.**
- **`agent/mcp.json`** — vazio no MVP (`{ "mcpServers": {} }`). MCPs entram quando uma skill demandar. **Novo.**
- **`profile/{.env.example, USER.example.md, mcp.example.json, config.yaml}`** — templates committed. `profile/.env`, `profile/USER.md`, `profile/mcp.json` ficam gitignored. **Novo.**
- **`context.example/`** — seed do vault Obsidian. README + subpastas (`personal`, `work`, `daily`, `templates`) + `templates/note.md`. Gabriel copia pra `context/` no setup. **Novo.**
- **`infra/Dockerfile`** — multi-stage, `node:24-slim`, user `node`, Claude CLI via `claude.ai/install.sh`. **Adaptado do Zeno** (corta AWS CLI, `gh`, `unzip`, `apps/api`, `apps/dashboard`).
- **`infra/docker-compose.yml`** — 2 services (`evolution-api` + `whis-worker`), 4 volumes (`whis_data`, `evolution_instances`, `evolution_store`, `claude_home`), 3 bind mounts (`./agent` RO, `./profile` RO, `./context` RW). **Novo.**
- **`infra/entrypoint.sh`** — symlink de skills `agent/` + `profile/` → `~/.claude/skills/`. **Adaptado do Zeno** (corta git_identity).
- **`infra/setup-evolution.sh`** — script idempotente: aguarda Evolution → cria instância "whis" → renderiza QR code → aguarda pareamento. **Novo.**

## Tech Stack

- **Runtime:** Node.js 24 LTS (validar em Task 0).
- **Linguagem:** TypeScript strict mode.
- **Package manager:** pnpm 10, workspaces declarados em `pnpm-workspace.yaml`.
- **Build / orchestration:** Turborepo (`turbo run lint typecheck test build`).
- **Lint / format:** Biome (substitui ESLint + Prettier).
- **Type check:** `tsc --noEmit`.
- **Tests:** Vitest.
- **Unused code detection:** Knip.
- **Agent runtime:** `@anthropic-ai/claude-agent-sdk` (in-process; OAuth via `CLAUDE_CODE_OAUTH_TOKEN`).
- **HTTP server (webhook):** Hono.
- **Storage:** `better-sqlite3` com `journal_mode = WAL`.
- **Logging:** `pino` (structured JSON em stdout).
- **Env validation:** `zod`.
- **Container base:** `node:24-slim` (Debian-slim).
- **Claude Code CLI:** instalado via `curl -fsSL https://claude.ai/install.sh | bash` — usado **só pra `claude setup-token`** (mintage one-time do OAuth token), não em runtime.
- **WhatsApp gateway:** Evolution API (`evoapicloud/evolution-api:v2.3.7`) — Baileys-based, autohospedado. Mantenedor migrou de `atendai/*` (abandonada) pra `evoapicloud/*` em 2025; validado em discovery 2026-04-25.
- **Volumes Docker:** `whis_data` (sqlite), `evolution_instances` + `evolution_store` (sessão WhatsApp Web), `claude_home` (`~/.claude`).

## File Structure

Cada arquivo do MVP, com responsabilidade de uma linha. Marcador 🆕 = arquivo novo, 🔁 = herdado 1:1 do Zeno (copiar + adaptar imports), 🔧 = derivado do Zeno (modificar seções).

**Root:**
- `package.json` 🆕 — workspaces + scripts (`docker:up`, `quality-gate`, etc)
- `pnpm-workspace.yaml` 🆕 — `apps/*` + `packages/*`
- `turbo.json` 🔁 — pipelines `lint`, `typecheck`, `test`, `build`
- `tsconfig.base.json` 🔁 — strict, ESM, paths
- `biome.json` 🔁 — lint/format rules (mesmo do Zeno)
- `knip.json` 🔁 — config Knip
- `.nvmrc` 🆕 — `24`
- `.dockerignore` 🆕 — `node_modules`, `.git`, `dist`, `tmp`
- `.gitignore` ✅ (já existe; revisar na Task 28)
- `README.md` 🆕 — setup completo + smoke test
- `AGENTS.md` 🔧 — guia pra Claude Code editar o projeto (adaptado do Zeno)
- `CLAUDE.md` 🆕 — pointer pra `AGENTS.md` (paridade Zeno)
- `docs/specs/0001-whis-mvp/spec.md` ✅ (já existe)
- `docs/specs/0001-whis-mvp/plan.md` 🆕 (este arquivo)
- `docs/specs/0001-whis-mvp/tasks.md` 🆕
- `docs/specs/0001-whis-mvp/discovery-notes.md` 🆕 (Task 0)

**`agent/` (identidade Whis — committed):**
- `agent/SOUL.md` 🆕 — personalidade, vault, modos, segurança
- `agent/mcp.json` 🆕 — `{ "mcpServers": {} }` (vazio no MVP)
- `agent/skills/hello-world/SKILL.md` 🆕

**`profile/` (config usuário — só `.example` committed):**
- `profile/.env.example` 🆕
- `profile/USER.example.md` 🆕
- `profile/mcp.example.json` 🆕
- `profile/config.yaml` 🆕 (committed; conteúdo: `always_active_skills: []`)
- `profile/skills/.gitkeep` 🆕

**`context.example/` (seed do vault — committed):**
- `context.example/README.md` 🆕
- `context.example/personal/.gitkeep` 🆕
- `context.example/work/.gitkeep` 🆕
- `context.example/daily/.gitkeep` 🆕
- `context.example/templates/note.md` 🆕

**`apps/worker/`:**
- `apps/worker/package.json` 🆕 — deps: `@anthropic-ai/claude-agent-sdk`, `hono`, `pino`, `zod`, `@whis/storage`, `@whis/logger`, devDeps: `vitest`, `@types/node`, `tsx`, `typescript`
- `apps/worker/tsconfig.json` 🆕 — extends `tsconfig.base.json`
- `apps/worker/vitest.config.ts` 🆕
- `apps/worker/src/index.ts` 🆕 (composition root)
- `apps/worker/src/config.ts` 🆕 (zod schema)
- `apps/worker/src/agent/types.ts` 🔁
- `apps/worker/src/agent/core.ts` 🔧 (3 alterações pontuais)
- `apps/worker/src/agent/system-prompt.ts` 🔁
- `apps/worker/src/agent/mcp.ts` 🔁
- `apps/worker/src/agent/backends/claude-code.ts` 🔁
- `apps/worker/src/agent/backends/mock.ts` 🔁
- `apps/worker/src/agent/backends/mock-fixtures.ts` 🔧 (fixtures adaptadas pra "oi/olá")
- `apps/worker/src/channels/types.ts` 🔁
- `apps/worker/src/channels/whatsapp/adapter.ts` 🆕
- `apps/worker/src/channels/whatsapp/evolution-client.ts` 🆕
- `apps/worker/src/channels/whatsapp/normalize.ts` 🆕
- `apps/worker/src/channels/whatsapp/format.ts` 🆕
- `apps/worker/src/webhook/server.ts` 🆕
- `apps/worker/src/profile/watcher.ts` 🔁

**`apps/worker/src/**/*.test.ts`:**
- `apps/worker/src/agent/system-prompt.test.ts` 🔁 (do Zeno)
- `apps/worker/src/agent/mcp.test.ts` 🔁
- `apps/worker/src/agent/core.test.ts` 🔧 (adaptar pra `wrapWithWhatsAppContext` e ausência de reaction final)
- `apps/worker/src/agent/backends/claude-code.test.ts` 🔁
- `apps/worker/src/channels/whatsapp/normalize.test.ts` 🆕
- `apps/worker/src/channels/whatsapp/format.test.ts` 🆕
- `apps/worker/src/webhook/server.test.ts` 🆕
- `apps/worker/src/profile/watcher.test.ts` 🔁

**`packages/storage/`:**
- `packages/storage/package.json` 🆕 — deps: `better-sqlite3`, devDeps: `@types/better-sqlite3`
- `packages/storage/tsconfig.json` 🆕
- `packages/storage/src/index.ts` 🆕 — re-exports
- `packages/storage/src/db.ts` 🔧 (subset do Zeno)
- `packages/storage/src/migrations/001_initial.sql` 🆕
- `packages/storage/src/session-repo.ts` 🔧 (adicionar `lastMessageAt`)
- `packages/storage/src/message-repo.ts` 🆕
- `packages/storage/src/session-repo.test.ts` 🔧
- `packages/storage/src/message-repo.test.ts` 🆕

**`packages/logger/`:**
- `packages/logger/package.json` 🆕 — deps: `pino`
- `packages/logger/tsconfig.json` 🆕
- `packages/logger/src/index.ts` 🔧 (subset sem `dbSink`)

**`infra/`:**
- `infra/Dockerfile` 🔧 (multi-stage simplificado)
- `infra/docker-compose.yml` 🆕 (2 services)
- `infra/entrypoint.sh` 🔧 (sem git_identity)
- `infra/setup-evolution.sh` 🆕

## Phase Ordering

Cada fase termina em estado verificável. Frequent commits dentro de cada task. Fases dependem da anterior salvo onde anotado.

1. **Phase 1: Discovery & Bootstrap (Tasks 0-3)** — não-código + workspace pronto. Estado final: `pnpm install` funciona, `pnpm run quality-gate` passa em projeto vazio.
2. **Phase 2: Storage Foundation (Tasks 4-6)** — `packages/storage` com schema, `SessionRepo`, `MessageRepo` + tests. Estado: `pnpm test --filter @whis/storage` verde.
3. **Phase 3: Logger (Task 7)** — `packages/logger` factory pino. Estado: tests verdes.
4. **Phase 4: Agent Types & Helpers (Tasks 8-12)** — `agent/types.ts`, `channels/types.ts`, `system-prompt.ts`, `mcp.ts`, `profile/watcher.ts`. Todos herdados 1:1. Estado: typecheck verde, tests herdados verdes.
5. **Phase 5: Backends (Tasks 13-14)** — `claude-code.ts` + `mock.ts` + `mock-fixtures.ts`. Estado: tests verdes; `MockBackend` instanciável.
6. **Phase 6: AgentCore (Task 15)** — `core.ts` com `wrapWithWhatsAppContext`, janela rotativa 6h, reactions só `eyes`. Estado: tests core verdes (em isolamento, com `MockBackend` + canal fake).
7. **Phase 7: WhatsApp Channel (Tasks 16-19)** — `format.ts`, `normalize.ts`, `evolution-client.ts`, `adapter.ts`. Estado: unit tests verdes; `WhatsAppChannel` instanciável.
8. **Phase 8: Webhook Server (Task 20)** — `webhook/server.ts` Hono. Estado: tests verdes; `/health` responde quando levantado em teste.
9. **Phase 9: Composition (Tasks 21-22)** — `config.ts` + `index.ts`. Estado: `node apps/worker/dist/index.js` boota com env mockada (sem Docker), pino loga `whis_online`.
10. **Phase 10: Identity & Skill (Tasks 23-26)** — SOUL.md, USER.example.md, .env.example, mcp.example.json, profile/config.yaml, agent/mcp.json, hello-world SKILL.md. Estado: `loadAgentFile('SOUL.md')` retorna conteúdo, hello-world descoberto pelo `loadAlwaysActiveSkills` se listado em config.yaml.
11. **Phase 11: Vault Template (Tasks 27-28)** — `context.example/` + `.gitignore` review. Estado: `cp -r context.example context` produz vault válido.
12. **Phase 12: Docker & Infra (Tasks 29-33)** — Dockerfile, entrypoint, compose, setup-evolution, scripts package.json. Estado: `pnpm run docker:build` produz imagem; `pnpm run docker:up` levanta os 2 services.
13. **Phase 13: Docs (Tasks 34-35)** — README.md, AGENTS.md, CLAUDE.md. Estado: humano consegue seguir o setup do README sem perguntar nada.
14. **Phase 14: Smoke Test (Task 36)** — execução manual S1, S2, S5, S7. Estado: todos os Success Criteria da spec observáveis.

**Dependencies notáveis (fora da ordem linear):**
- Tasks 8-12 (herdados 1:1) podem ser paralelizadas — não dependem entre si além de `agent/types.ts` (que vem antes).
- Tasks 16-18 (format, normalize, evolution-client) podem ser paralelizadas; Task 19 (`adapter.ts`) depende das 3.
- Phase 10 (identidade) pode rodar em paralelo com Phases 5-9 — só toca markdown e JSON.
- Phase 11 (vault template) é independente; pode rodar a qualquer momento após Phase 1.

## Notas operacionais

- **Git já inicializado.** A Success Criterion #1 da spec ("git init && git add . && git commit -m 'init'") foi cumprida no commit `f3f5b81` antes da geração deste plano (a pedido do Gabriel). Não há task de `git init` no `tasks.md` por isso. Reviewer da spec deve interpretar SC#1 como "repo iniciado e plano commitado", não "iniciar repo".
- **Smoke runs em Windows.** Os passos de smoke do Task 22 e do Task 36 que usam `\` continuação de linha em bash são melhor executados em **Git Bash** ou dentro do container (`pnpm run docker:sh`). PowerShell precisa de adaptação manual.
- **Verificação de signatures herdadas.** Após Task 10 (system-prompt) e Task 14 (mock backend), confirmar que as assinaturas reais do Zeno batem com o uso esperado em Task 22 (`index.ts`):
  - `loadAgentFile(filename) → string | null`
  - `loadProfileFile(filename) → string | null`
  - `loadAlwaysActiveSkills(names: string[]) → string[]`
  - `buildSystemPrompt(soul, user, skills) → string`
  - `MockFixture` shape (Zeno usa `{ match: RegExp; output: AgentOutput }` ou variação?)
  Se houver divergência, ajustar Task 22 / Task 14 antes de prosseguir — não inflar especulação aqui.

## Risks / Open Decisions

**Locked-in pelo brainstorming (não re-abrir sem voltar à spec):**
- Ports & adapters herdado do Zeno.
- Claude Code OAuth (não `ANTHROPIC_API_KEY`).
- Evolution API como gateway WhatsApp (não Baileys direto).
- Single profile (sem subpasta `default/`).
- Multi-ambiente cognitivo via SOUL + vault subpastas (sem código adicional).
- Janela rotativa de 6h (`SESSION_IDLE_HOURS`).
- `SessionRepo` + `MessageRepo` em better-sqlite3.
- Hono pro webhook server.
- Reactions: só `eyes` (👀) on/off — sem ✅/⚠️.
- Sem cron, sem dashboard, sem guardrails no MVP.

**Resolvidos pela discovery (2026-04-25, ver `discovery-notes.md`):**
- ✓ `@anthropic-ai/claude-agent-sdk` 0.2.119 (saltou minor desde 0.1.4x). Contrato `query()` preservado.
- ✓ Imagem Evolution: trocada pra `evoapicloud/evolution-api:v2.3.7` (`atendai/*` foi abandonada). Endpoints e schema do webhook `messages.upsert` preservados.
- ✓ Hono 4.12.15 ainda recomendado, sem mudança de sintaxe.
- ✓ `better-sqlite3` 12.9.0 com prebuilt pra Node 24 (glibc — `node:24-slim` está OK).
- ✓ Node 24 ainda é Active LTS (até abril/2027).
- ✓ `node:24-slim` ainda é o tag recomendado.

**Risco resolvido após discovery, mantido como aceito:**
- **Política OAuth do Agent SDK** — Anthropic proibiu OAuth (Free/Pro/Max) em agentes programáticos em fev/2026. Whis aceita o risco no MVP; fallback é trocar pra `ANTHROPIC_API_KEY` (zero código muda — SDK resolve precedência). Detalhe na tabela "Risks and Mitigations" da spec.

**Aceitos como conhecidos (documentados, não bloqueiam MVP):**
- Idempotência de webhook não fechada (Evolution pode retentar; risco de resposta dupla rara). Fix planejado pós-MVP via UNIQUE em `messages.message_ref`.
- `bypassPermissions` no Claude SDK = agente executa Bash/Write sem confirmação. Mitigação: `cwd=/app/context` + SOUL.md proibindo sair, container = sandbox, ações irreversíveis exigem confirmação por instrução. Guardrails pós-MVP.
- Pareamento WhatsApp Web manual via QR code; sessão pode cair se WhatsApp invalidar (ex: logout no app). Re-rodar `evolution:setup`.
- Janela de sessão de 6h é chute fundamentado; ajustável via `SESSION_IDLE_HOURS`.

**Riscos novos não cobertos pela spec:**
- **Cold start do `better-sqlite3` no Alpine Linux.** O Zeno usa `node:24-slim` (Debian) — `better-sqlite3` compila prebuilt nessa imagem. Se algum dia migrarmos pra Alpine, exige rebuild. Não bloqueia MVP (`node:24-slim` é a escolha).
- **Claude CLI install no container.** O script `curl ... | bash` pode falhar se o domínio mudar ou redirecionar. Discovery valida; fallback é instalar manualmente via `npm install -g @anthropic-ai/claude-code`.
- **Volume `claude_home` external.** Se o usuário esquecer de rodar `docker volume create claude_home` antes do primeiro `docker:up`, o compose falha com mensagem clara — README cobre.

---

Execução detalhada está em `[[tasks]]`.
