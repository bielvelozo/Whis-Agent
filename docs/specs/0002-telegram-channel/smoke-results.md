---
feature: telegram-channel
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-04-25
---
# Telegram Channel — Smoke Test Results

**Data:** 2026-04-25
**Executor:** Gabriel
**Modo:** Telegram-only (WHATSAPP_ENABLED=false default; WhatsApp dormente)

## Success Criteria observados

- [x] **T1 — Setup completo:** BotFather `/newbot` → cola token em `.env` → `pnpm run telegram:setup` → manda `/start` no app → captura `TELEGRAM_OWNER_CHAT_ID` → cola no `.env`. Fluxo cumprido.
- [x] **T2 — Caminho feliz:** `oi` no chat com o bot → 👀 reage → resposta personalizada do `hello-world` em PT-BR → 👀 sai. Logs com sequência completa, todos com `channel: 'telegram'`.
- [ ] **T3 — Não-owner:** *não testado.* Lógica coberta por unit tests (`normalize.test.ts` reject quando `chat.id !== ownerChatId`).
- [ ] **T4 — Dual-canal:** *deferido.* Aguarda compra de chip dedicado WhatsApp.
- [x] **`channel` field nos logs:** confirmado em `telegram_health_ok`, `backend_started`, `backend_completed`, `response_sent`, etc.
- [x] **Composition root condicional:** `whis_online` log mostrou `activeChannels: ["telegram"]` — só Telegram subiu, postgres+evolution-api ficaram dormente (profile `[whatsapp]`).
- [x] **Quality-gate verde:** 11 tasks ok, **91 tests passando** (53 do MVP + 38 novos da spec 0002).

## Bugs descobertos no smoke real (todos com fix commitado)

1. **`profile/.env` corrupto** com logs colados acidentalmente nas linhas 30-31 — quebrava o parser do docker compose. Limpeza manual no `.env` local (gitignored, sem commit).
2. **`stripKeyspace` faltando no `TelegramChannel.send/react/unreact`** — `conversationId` com prefix `tg:` (necessário pro keyspace de SessionRepo) era passado direto pra Bot API, que só aceita `chat_id` numérico. Sintoma: `GrammyError: Call to 'sendMessage' failed! (400: Bad Request: chat not found)`. Fix em commit `6bb2d28` — helper `stripKeyspace()` remove `tg:` antes de chamar grammy. 7 tests do adapter atualizados.
3. **`grammy 1.42.0`** (não 2.x como originalmente assumido na spec) — descoberto na Task 0; spec/plan amendados.
4. **`setMessageReaction` signature** divergente do que a spec assumia — em grammy 1.x, é positional `(chat_id, message_id, reaction[])`, não objeto. Corrigido em T6.
5. **Lista de emojis suportados pelo Telegram é restrita** (~70 emojis padrão). `white_check_mark` (✅) e `warning` (⚠️) NÃO estão. Mapping reduzido a só `eyes` (👀).
6. **Compose `depends_on: evolution-api`** no `whis-worker` bloqueava boot quando WhatsApp dormante. Removido em T8.

## Métricas observadas

- **Cold start:** primeiro `oi` chegou no `backend_started` ~64s após `whis_online`, completou em 5s no Claude. Resposta enviada em sequência.
- **Steady state:** não medido formalmente; UX subjetiva "rápida" pós-cold-start.
- **Logs estruturados:** sequência completa observada com `correlationId` consistente por turno.

## Status

**Spec 0002 shipped.** Whis agora roda no Telegram como canal default. WhatsApp permanece testado (intacto via tests + commits do MVP) e prontamente reativável via `WHATSAPP_ENABLED=true` + `--profile whatsapp`.

Próximas iterações sugeridas: skills concretas que exercitem o vault (calendar/agenda, daily notes, hábitos).
