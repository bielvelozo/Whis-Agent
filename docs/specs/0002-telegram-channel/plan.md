---
feature: telegram-channel
spec: "[[spec]]"
created: 2026-04-25
---
# Telegram Channel — Implementation Plan

> **For agentic workers:** Use a subagent-driven loop or inline execution to implement this plan task-by-task. Steps in `[[tasks]]` use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar `TelegramChannel` (via `grammy` + long-polling) como canal alternativo do Whis, com flags por canal que mantêm o `WhatsAppChannel` dormente até o Gabriel ter chip dedicado, sem refator no que já funciona da spec 0001.

**Architecture:** Reusa Ports & Adapters herdado do MVP — `Channel` interface não muda. `TelegramChannel` espelha a estrutura de `WhatsAppChannel` (`adapter.ts` + `normalize.ts` + `format.ts`). Composition root passa a iterar uma lista de canais habilitados (zero, um ou dois). AgentCore.bind permanece per-channel; o composition root chama uma vez por canal ativo. Sessões isoladas por keyspace prefixed (`tg:<chat_id>` vs `<jid>@s.whatsapp.net`).

**Tech Stack:** Igual ao MVP — TypeScript strict + Node 24 + pnpm 10 + Turborepo + Hono + Zod + Vitest + Biome. **Nova dependência runtime:** `grammy` 2.x. Sem dependência transitiva nova significativa (grammy é leve, só `node-fetch` + `debug` na árvore). `tsx` (já dev-dep) é usado pelo helper `infra/setup-telegram.ts`.

---

## Approach

A implementação reusa **literalmente** as decisões arquiteturais do MVP 0001. `TelegramChannel` é mais uma implementação ao lado de `WhatsAppChannel`, ambas atendendo à mesma interface `Channel`. Diferenças concretas:

1. **Canal:** Telegram via `grammy` Bot API (vs WhatsApp via Evolution+Baileys). Long-polling em vez de webhook — zero infra pública, conexão idle outbound HTTPS.
2. **Format:** MarkdownV2 do Telegram exige escape mais agressivo que o WhatsApp markdown — caracteres `_*[]()~`>#+-=|{}.!` precisam `\` quando não fazem parte de marcação. `format.ts` próprio com stage-based placeholders ASCII (mesmo padrão do WhatsApp).
3. **Reactions:** `setMessageReaction` (Bot API 7.0+) cobre `react/unreact` na exata UX do MVP — 👀 entra no recebimento, sai na resposta.
4. **Sem `fromMe` problem:** Telegram bot é entidade distinta do user (bot ID ≠ user ID). Tracker do single-number patch (existente em `WhatsAppChannel`) é WhatsApp-only e não precisa equivalente.

A primeira tarefa do plano é **Task 0: Discovery**, validando em runtime real (NAO assumido) o shape da API do `grammy` 2.x — versão exata, comportamento de `bot.start()` (blocking ou não), assinatura de `Context`, payload de `Update`, contrato exato de `setMessageReaction`. Findings em `docs/specs/0002-telegram-channel/discovery-notes.md`.

A composição (`apps/worker/src/index.ts`) ganha lógica condicional: lê `config.telegram.enabled` e `config.whatsapp.enabled`; instancia cada canal só se habilitado; falha rápido se ambos desabilitados. `AgentCore.bind(channel)` é chamado uma vez por canal ativo — handler de cada canal captura sua referência por closure. Não há refator do `AgentCore`: ele continua per-channel. O comentário em 0002/spec sobre `Map<platform, Channel>` interno foi simplificação otimista — a leitura do código mostra que múltiplos `bind`s separados é mais limpo e suficiente.

Compose ganha Docker Compose `profiles: [whatsapp]` em `evolution-api` e `postgres`. `pnpm run docker:up` (sem `--profile whatsapp`) só sobe `whis-worker`. Quando WhatsApp voltar, `pnpm run docker:up --profile whatsapp` traz os 3.

## Architecture

```
                          docker network interno
                ┌──────────────────────────────────────┐
                │                                      │
       ┌──polling outbound HTTPS─────►api.telegram.org │
       │                                                │
       │                                                │
   whis-worker (Node)                                   │
   ┌─────────────────────────────┐                      │
   │ Hono :8080 /health          │                      │
   │  channels: {tg:on, wa:off}  │                      │
   │                              │                     │
   │ TelegramChannel              │                     │
   │  - grammy Bot polling        │                     │
   │  - getMe healthcheck         │                     │
   │  - normalize/format          │                     │
   │      │                       │                     │
   │      ▼                       │                     │
   │ AgentCore (chamado 1x por canal)                   │
   │  - bind(telegramChannel) ✓                         │
   │  - bind(whatsappChannel) DORMANT (flag off)        │
   │  - SessionRepo (key tg:<id> | <jid>)               │
   │  - MessageRepo                                     │
   │      │                                             │
   │      ▼                                             │
   │ ClaudeCodeBackend                                  │
   │  cwd=/app/context                                  │
   └────────────┬────────────────┘                      │
                │                                       │
                ▼                                       │
   [ vault Obsidian (context/) ]                        │
   [ sqlite: /app/data/whis.db ]                        │

   Compose profile [whatsapp]: dormente, não sobe sem --profile flag.
   evolution-api + postgres ficam parados quando WHATSAPP_ENABLED=false.
```

**Component responsibilities:**

- **`Channel`** (port, `apps/worker/src/channels/types.ts`) — INALTERADO. Interface canal-agnóstica.
- **`TelegramChannel`** (`apps/worker/src/channels/telegram/adapter.ts`) — implementa `Channel` via `grammy`. Polling via `Bot.start()` em background; healthcheck via `bot.api.getMe()` no boot; `send` via `bot.api.sendMessage` com `parse_mode: 'MarkdownV2'`; `react/unreact` via `bot.api.setMessageReaction`; `waitForReaction` é no-op (paridade WhatsApp). **Novo arquivo.**
- **`telegram/normalize.ts`** (`apps/worker/src/channels/telegram/normalize.ts`) — converte `Update` da Bot API em `IncomingMessage`. Whitelist por `TELEGRAM_OWNER_CHAT_ID`. Filtra `chat.type !== 'private'`. Filtra tipos não-texto. **Novo.**
- **`telegram/format.ts`** (`apps/worker/src/channels/telegram/format.ts`) — traduz markdown do Claude pra MarkdownV2 do Telegram. Escape agressivo via stage-based placeholders ASCII (`__WHIS_C_<n>__`, `__WHIS_B_<n>__`). **Novo.**
- **`config.ts`** (`apps/worker/src/config.ts`) — schema zod estendido: `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`, `WHATSAPP_ENABLED`. Refine condicional: se canal habilitado, suas envs específicas são obrigatórias; pelo menos um canal deve estar habilitado. **Modificado.**
- **`index.ts`** (`apps/worker/src/index.ts`) — composition root passa a iterar canais habilitados. Para Telegram: instancia client → healthcheck `getMe` → cria `TelegramChannel` → `core.bind(channel)` → `channel.start(handler)`. Para WhatsApp: lógica atual, condicional. **Modificado.**
- **`agent/core.ts`** (`apps/worker/src/agent/core.ts`) — `wrapWithWhatsAppContext` é renomeada/generalizada para `wrapMessageContext` que despacha por `message.platform`. Adiciona `wrapWithTelegramContext` (header `[telegram_context]`). **Modificado em 1 função interna.**
- **`webhook/server.ts`** (`apps/worker/src/webhook/server.ts`) — `/health` retorna `channels: { telegram: {...}, whatsapp: {...} }` em vez de `evolutionPing` direto. **Modificado.**
- **`infra/setup-telegram.ts`** — script novo invocado por `pnpm run telegram:setup`. Cria bot temporário com token do `.env`, faz `getMe`, espera primeira mensagem, imprime `chat_id`, encerra. Idempotente. **Novo.**
- **`infra/docker-compose.yml`** — `evolution-api` e `postgres` ganham `profiles: [whatsapp]`. `whis-worker` continua default. **Modificado.**
- **Docs** — `AGENTS.md` (tabela de comandos), `SMOKE.md` (seção Setup Telegram + troubleshooting), `profile/.env.example` (envs novas).

## Tech Stack

- **Runtime:** Node.js 24 LTS (mantido).
- **Linguagem:** TypeScript strict (mantido).
- **Package manager:** pnpm 10 (mantido).
- **Build:** Turborepo + tsc + tsc-alias (mantido).
- **Tests:** Vitest (mantido).
- **Lint/format:** Biome (mantido).
- **Telegram lib:** `grammy` 2.x (versão exata pinada após Task 0). Adicionada como dep de `apps/worker/package.json`.
- **HTTP server:** Hono (mantido — só `/health` muda).
- **Storage:** better-sqlite3 (mantido — `SessionRepo`/`MessageRepo` reusados sem mudança).
- **Evolution API:** mantida em `v2.3.7` mas dormante em modo default. Imagem do compose intacta.

## File Structure

Cada arquivo do feature, com responsabilidade de uma linha. 🆕 = novo, 🔧 = modificado, ✅ = não muda.

**`apps/worker/src/channels/telegram/`:** *(diretório novo)*
- `adapter.ts` 🆕 — `TelegramChannel` implements `Channel`
- `normalize.ts` 🆕 — `Update` Telegram → `IncomingMessage`, whitelist + filtros
- `format.ts` 🆕 — markdown Claude → MarkdownV2 (stage placeholders)
- `adapter.test.ts` 🆕 — mocks `Bot` do grammy, valida lifecycle/calls
- `normalize.test.ts` 🆕 — fixtures `Update`, casos de aceitação/rejeição
- `format.test.ts` 🆕 — escape MarkdownV2, conversão markdown

**`apps/worker/src/`:** *(modificações pontuais)*
- `config.ts` 🔧 — adiciona TELEGRAM_*, WHATSAPP_ENABLED + refine condicional
- `config.test.ts` 🔧 — tests pra refine
- `index.ts` 🔧 — composition root condicional, lista de canais
- `agent/core.ts` 🔧 — `wrapMessageContext` despacha por platform, `wrapWithTelegramContext` novo
- `agent/core.test.ts` 🔧 — tests de multi-canal + isolamento de sessão
- `webhook/server.ts` 🔧 — `/health` ganha `channels` field
- `webhook/server.test.ts` 🔧 — atualiza assertion de `/health`

**`apps/worker/package.json`:** 🔧 — `grammy ^2.x` em deps.

**`infra/`:**
- `setup-telegram.ts` 🆕 — helper de discovery do `OWNER_CHAT_ID`
- `docker-compose.yml` 🔧 — `profiles: [whatsapp]` em evolution-api + postgres

**Root:**
- `package.json` 🔧 — adicionar script `telegram:setup`
- `profile/.env.example` 🔧 — novas envs Telegram + flag WhatsApp
- `AGENTS.md` 🔧 — tabela de comandos com `telegram:setup`
- `SMOKE.md` 🔧 — seção 13 Setup Telegram + troubleshooting Telegram

**`docs/specs/0002-telegram-channel/`:**
- `spec.md` ✅ — já escrita e aprovada
- `plan.md` 🆕 — este arquivo
- `tasks.md` 🆕
- `discovery-notes.md` 🆕 — Task 0 output

## Phase Ordering

Cada fase termina em estado verificável. Frequent commits dentro de cada task. Fases dependem da anterior salvo onde anotado.

1. **Phase 1: Discovery (Task 0)** — não-código. Estado final: `discovery-notes.md` commitado, versão grammy pinada, contratos validados.
2. **Phase 2: Config & dep (Task 1)** — `grammy` instalado, schema zod estendido com refine, tests verdes. Estado: `pnpm install` + `pnpm --filter @whis/worker test config.test.ts` verdes.
3. **Phase 3: Telegram normalize (Task 2)** — TDD. Estado: 6+ tests verdes em `telegram/normalize.test.ts`.
4. **Phase 4: Telegram format (Task 3)** — TDD. Estado: 7+ tests verdes em `telegram/format.test.ts`, escape correto.
5. **Phase 5: Telegram adapter (Task 4)** — TDD com mock de `Bot`. Estado: 5+ tests verdes em `telegram/adapter.test.ts`, `Channel` interface satisfeita.
6. **Phase 6: AgentCore multi-canal (Task 5)** — `wrapMessageContext` despachando, tests adicionais. Estado: tests existentes + novos verdes.
7. **Phase 7: Composition root (Task 6)** — `index.ts` condicional, `pnpm --filter @whis/worker build` produz dist resolvível em Node ESM. Estado: bundle resolve com env mockada.
8. **Phase 8: Setup helper (Task 7)** — `infra/setup-telegram.ts` + script `telegram:setup` no `package.json`. Estado: script roda local com `tsx` e captura chat_id em ambiente de teste.
9. **Phase 9: Compose profiles (Task 8)** — `evolution-api` + `postgres` com `profiles: [whatsapp]`. Estado: `docker compose -f infra/docker-compose.yml --project-directory . config` valida; `up` sem flag só sobe worker.
10. **Phase 10: /health expandido (Task 9)** — endpoint retorna mapa de canais. Tests atualizados. Estado: GET `/health` em runtime mostra `{ channels: { telegram: { enabled, ping }, whatsapp: { enabled } } }`.
11. **Phase 11: Docs (Task 10)** — `AGENTS.md`, `SMOKE.md`, `.env.example` atualizados. Estado: humano em PC limpo consegue seguir Setup Telegram do SMOKE.md sem perguntar.
12. **Phase 12: Smoke manual (Task 11)** — execução T1 (setup), T2 (caminho feliz), T3 (não-owner). T4 (dual ativo) e T6 (token revogado) deferidos. Estado: `smoke-results.md` da feature 0002 commitado.

**Dependencies notáveis:**
- Tasks 2-4 (normalize, format, adapter) podem ser paralelizadas — não dependem entre si. Adapter depende de Channel interface (já existe) + grammy types (Task 1).
- Task 5 (AgentCore) é independente de Tasks 2-4 — só toca `core.ts` e tests.
- Task 6 (index.ts) depende de Tasks 1-5 (precisa dos artefatos pra wirar).
- Task 7 (setup helper) só depende de Task 1 (grammy instalado).
- Tasks 8 (compose), 9 (/health), 10 (docs) são independentes entre si após Task 6.

## Notas operacionais

- **Validação no boot vs runtime:** zod refine garante boot fail-fast quando `TELEGRAM_ENABLED=true` sem TOKEN/OWNER. `getMe` é runtime-fail (loga `telegram_health_failed`, segue se outro canal estiver ok). Token revogado em runtime: grammy retenta automaticamente, eventualmente loga warns.
- **Migration safety da spec 0001:** `WhatsAppChannel` não é tocado. Tests existentes (50+ originais + 3 single-number = 53) continuam verdes — Phase 5 só adiciona tests novos pro AgentCore multi-canal sem tocar nos antigos.
- **`config.evolution.*`/`config.whatsapp.ownerNumber` viram opcional quando `WHATSAPP_ENABLED=false`.** Refine no zod garante. `index.ts` só lê esses campos quando ativa o WhatsAppChannel.
- **Smoke runs em Windows.** Comando `pnpm run telegram:setup` (TS via tsx) roda nativo em PowerShell **e** Git Bash. Não usa `.sh`.
- **Backward compat das sessões existentes:** sessões já gravadas no `whis.db` (chat_id = `<jid>@s.whatsapp.net`) continuam válidas quando WhatsApp reativar. Telegram cria entries novas com prefix `tg:`.

## Risks / Open Decisions

**Locked-in pelo brainstorming (não re-abrir sem voltar à spec):**
- `grammy` como lib (descartadas `telegraf`, `node-telegram-bot-api`).
- Long-polling, não webhook.
- Flags por canal (`TELEGRAM_ENABLED`, `WHATSAPP_ENABLED`) em vez de `ACTIVE_CHANNEL` exclusivo.
- Reactions implementadas via `setMessageReaction`.
- Format MarkdownV2 próprio (não reusa WhatsApp).
- Sessões isoladas por keyspace prefixed.

**Resolvíveis em Task 0 (Discovery):**
- Versão exata do `grammy` (esperado: 2.x latest).
- Comportamento de `bot.start()` em grammy 2.x — se é blocking (precisa `void` na chamada), se aceita opções de polling timeout.
- Shape exato do `Update.message` em DM: `from`, `chat`, `text`, `message_id`.
- Contrato exato de `setMessageReaction({ chat_id, message_id, reaction: [{ type, emoji }] })`.
- Tratamento de erros do grammy: `bot.catch()` API, classes de erros (token inválido vs network vs rate limit).

**Aceitos como conhecidos (documentados, não bloqueiam):**
- Idempotência de Update não fechada — Telegram pode retentar entrega; risco de resposta dupla rara aceito.
- Token leak compromete identidade do bot, mas whitelist `TELEGRAM_OWNER_CHAT_ID` impede atacante de acionar Whis.
- Helper `telegram:setup` é interativo (espera mensagem do user). Timeout de 5min documentado.

**Riscos novos:**
- Mudança recente da Bot API entre grammy 2.x e o que assumimos pode quebrar `setMessageReaction`. Discovery valida.
- Polling pode falhar se rede do Docker não permitir outbound HTTPS pra `api.telegram.org`. Em hosts comerciais (AWS/GCP/Render) é OK; em VPS com firewall agressivo, requer ajuste. Não aplica ao MVP local.

---

Execução detalhada está em `[[tasks]]`.
