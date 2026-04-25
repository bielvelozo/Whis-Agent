---
feature: whis-mvp
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-04-25
---
# Whis MVP — Smoke Test Results

**Data:** 2026-04-25
**Executor:** Gabriel
**Modo:** single-number (chip antigo morto, patch aplicado mid-smoke)

## Success Criteria observados

- [x] **S1 — Caminho feliz:** `oi` no chat "Mensagem enviada a mim mesmo" → Whis respondeu no mesmo chat. Pipeline ponta-a-ponta funcional (Evolution → webhook → AgentCore → Claude SDK → resposta WhatsApp).
- [ ] **S2 — Número não autorizado:** *não testado.* Single-number mode + sem chip secundário pra simular sender fora da whitelist. Lógica testada via unit tests (`normalize.test.ts` cobre o `dm_ignored_non_owner` path).
- [ ] **S5 — Token Claude expirado:** *não testado.* Coberto por unit tests no `claude-code.test.ts` (classificação de erro `auth_expired` + tradução PT-BR). Dispense da validação manual aceita.
- [ ] **S7 — Hot-reload do SOUL:** *não testado.* `ProfileWatcher` tem unit tests verdes (`watcher.test.ts`). Validação manual fica como follow-up se prompt mudar.
- [x] **Logs estruturados com correlationId:** sequência observada `boot_start → db_opened → migrations_applied → soul_md_loaded → user_md_loaded → whis_online`. Eventos por turno (`message_received → response_sent`) compartilham o mesmo `correlationId` (validado em runtime).
- [x] **Quality-gate verde:** `pnpm run quality-gate` → 11 tasks ok, **53 tests passing** (50 originais + 3 do single-number patch).

## Gaps descobertos no smoke (não previstos pela discovery)

Documentados em detalhe em `discovery-notes.md` (seção *Amendment 2026-04-25*). Resumo:

1. **CRLF em checkouts Windows** — `core.autocrlf=true` quebrava lint do Biome. Fix: `.gitattributes` força LF universal.
2. **`@types/node` faltando em `@whis/storage`** — typecheck/build falhava em fresh install. Fix: devDep adicionada.
3. **Biome 2.4.13 mais estrito** que a versão de dev (2.4.12) — `organizeImports` alfabético + `noControlCharactersInRegex`. Fix: auto-fix em 23 arquivos + refactor de `format.ts` pra placeholders ASCII.
4. **ESM strict do Node não casa com `moduleResolution: Bundler`** — `dist/*.js` saía com imports sem `.js` e com aliases `@/*` literais. Fixes: `.js` explícito no storage; `tsc-alias --resolve-full-paths` no worker.
5. **Evolution v2 exige Postgres externo** — discovery cobriu schema/imagem mas perdeu o requisito infra. Fix: service `postgres:16-alpine` + envs `DATABASE_*`.
6. **Webhook do worker exigia `apikey` que Evolution não envia** com `WEBHOOK_GLOBAL_URL`. Fix: env opcional `WEBHOOK_REQUIRE_APIKEY` (default false).
7. **Bug stream:error 515 + Pre-key timeout da Evolution v2.3.x** — issue umbrella oficial #2437, sem fix em release. Workaround aplicado: `CONFIG_SESSION_PHONE_VERSION` específico + `CACHE_LOCAL_ENABLED` + `DATABASE_SAVE_DATA_*=false`. Caveat: o valor de `CONFIG_SESSION_PHONE_VERSION` precisa atualização manual quando WhatsApp mudar protocolo.

## Mudanças além do plano original

Single-number mode (feat `5593ac1`/post-rebase): patch pra suportar setup com 1 número só, via tracker em memória de IDs emitidos pelo próprio Whis. Não estava na spec — entrou mid-smoke quando descobrimos que o chip antigo do Gabriel estava morto. Trade-off documentado em `SMOKE.md`.

## Métricas observadas

- **Cold start (1ª mensagem após boot):** ~30-45s (dentro do budget aceitável da spec).
- **Steady state (turnos seguintes):** não medido formalmente; subjetivamente "ok" (alguns segundos).
- **Sync inicial do histórico WhatsApp:** ~45s pra 4978 msgs (após pareamento). Acompanhado nos logs da Evolution; não bloqueia o uso normal depois.

## Status

**MVP shipped.** Próximas iterações ficam a critério do Gabriel — sugestões em aberto: skill nova que use o vault (`daily-note`, `quick-task`), cron pra hábitos, ou retomar setup dual-number quando tiver chip dedicado disponível.
