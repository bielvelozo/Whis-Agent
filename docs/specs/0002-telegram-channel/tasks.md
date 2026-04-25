---
feature: telegram-channel
plan: "[[plan]]"
spec: "[[spec]]"
created: 2026-04-25
---
# Telegram Channel — Tasks

**For this plan:** `[[plan]]`

Cada task é auto-contida; trabalhe em ordem (algumas tasks podem ser paralelizadas — ver `[[plan]]` "Dependencies notáveis"). Cada task termina em commit. Step usa checkbox `- [ ]` pra tracking.

---

## Phase 1: Discovery

### Task 0: Discovery não-código

**Purpose:** Validar versão atual do `grammy`, comportamento de `bot.start()`, shape do `Update`, contrato de `setMessageReaction`. Reduz risco de descobrir incompat tarde.

**Files:**
- Create: `docs/specs/0002-telegram-channel/discovery-notes.md`

- [ ] **Step 1: Conferir versão atual do grammy no npm**

```bash
npm view grammy version
npm view grammy peerDependencies engines
```

Anotar versão major.minor.patch atual. Confirmar engines aceita Node ≥24.

- [ ] **Step 2: Validar polling lifecycle**

Ler https://grammy.dev/guide/getting-started e https://grammy.dev/guide/long-polling. Anotar:
- `Bot.start()` é blocking ou retorna Promise?
- Como passar opções de polling (timeout, allowed_updates)?
- Como rodar `getMe()` antes do polling sem race com handlers?

- [ ] **Step 3: Validar contrato de setMessageReaction**

Ler https://grammy.dev/ref/core/api e https://core.telegram.org/bots/api#setmessagereaction. Anotar exato:
- Argumentos: `chat_id` (number/string), `message_id` (number), `reaction` (array de `ReactionTypeEmoji`).
- Como remover reaction? Array vazia ou outro mecanismo?
- Quais emojis são suportados (lista limitada do Telegram)?

- [ ] **Step 4: Confirmar shape do Update.message em DM**

Ler https://core.telegram.org/bots/api#message. Anotar campos relevantes pra `IncomingMessage`:
- `message_id: number`
- `chat: { id: number; type: 'private' | 'group' | ...; first_name?: string; username?: string }`
- `from: { id: number; is_bot: boolean; first_name: string; username?: string }`
- `text?: string`
- `date: number`

- [ ] **Step 5: Confirmar tratamento de erros do grammy**

Ler https://grammy.dev/guide/errors. Anotar:
- `bot.catch(handler)` API.
- Como detectar token inválido vs network error vs flood limit?
- Há class hierarchy de erros (`GrammyError`, `HttpError`)?

- [ ] **Step 6: Escrever discovery-notes.md**

```markdown
# Discovery — Telegram Channel (0002)

**Data:** 2026-04-25
**Verificado por:** Gabriel

## 1. grammy

**Versão atual:** [versão]
**Engines:** [Node ≥X.Y]

## 2. Polling

[anotações sobre Bot.start(), getMe ordering]

## 3. setMessageReaction

[contrato exato, payload, remoção]

## 4. Update.message shape

[campos esperados]

## 5. Error handling

[bot.catch, classes de erro]

## Verdict

[OK / amend spec se algo mudou material]
```

- [ ] **Step 7: Commit**

```bash
git add docs/specs/0002-telegram-channel/discovery-notes.md
git commit -m "docs(discovery): findings da Task 0 — grammy 2.x + Bot API contracts"
```

---

## Phase 2: Config & Dep

### Task 1: Adicionar grammy + estender zod schema

**Files:**
- Modify: `apps/worker/package.json`
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/config.test.ts`

- [ ] **Step 1: Instalar grammy**

```bash
pnpm --filter @whis/worker add grammy
```

Verifica que `apps/worker/package.json` ganhou `"grammy": "^2.x.y"` em `dependencies`.

- [ ] **Step 2: Estender schema do config.ts**

Edit `apps/worker/src/config.ts`. Adicionar campos no schema antes do `.refine`:

```typescript
const schema = z
  .object({
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),

    // WhatsApp (agora opcional, validado por refine)
    WHATSAPP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    EVOLUTION_BASE_URL: z.string().url().optional(),
    EVOLUTION_API_KEY: z.string().min(1).optional(),
    EVOLUTION_INSTANCE: z.string().min(1).default('whis'),
    WHATSAPP_OWNER_NUMBER: z
      .string()
      .regex(/^\d{10,15}$/, { message: 'must be digits only' })
      .optional(),

    // Telegram
    TELEGRAM_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_OWNER_CHAT_ID: z.coerce.number().int().optional(),

    // Worker (mantido)
    WORKSPACE_DIR: z.string().default('/app/context'),
    DATA_DIR: z.string().default('/app/data'),
    WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    WEBHOOK_REQUIRE_APIKEY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(168).default(6),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    WHIS_BACKEND: z.enum(['claude-code', 'mock']).default('claude-code'),
  })
  .refine(
    (env) => env.WHATSAPP_ENABLED || env.TELEGRAM_ENABLED,
    { message: 'pelo menos um canal deve estar habilitado: WHATSAPP_ENABLED ou TELEGRAM_ENABLED' },
  )
  .refine(
    (env) =>
      !env.WHATSAPP_ENABLED ||
      (!!env.EVOLUTION_BASE_URL && !!env.EVOLUTION_API_KEY && !!env.WHATSAPP_OWNER_NUMBER),
    {
      message:
        'WHATSAPP_ENABLED=true exige EVOLUTION_BASE_URL, EVOLUTION_API_KEY, WHATSAPP_OWNER_NUMBER',
    },
  )
  .refine(
    (env) => !env.TELEGRAM_ENABLED || (!!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_OWNER_CHAT_ID),
    { message: 'TELEGRAM_ENABLED=true exige TELEGRAM_BOT_TOKEN e TELEGRAM_OWNER_CHAT_ID' },
  );
```

Atualiza tipo `Config` (após o schema):

```typescript
export interface Config {
  claude: { oauthToken: string };
  whatsapp: {
    enabled: boolean;
    ownerNumber: string | null;
  };
  evolution: {
    enabled: boolean;
    baseUrl: string | null;
    apiKey: string | null;
    instance: string;
  };
  telegram: {
    enabled: boolean;
    botToken: string | null;
    ownerChatId: number | null;
  };
  workspaceDir: string;
  dataDir: string;
  webhookPort: number;
  webhookRequireApiKey: boolean;
  sessionIdleHours: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  backend: 'claude-code' | 'mock';
}
```

Atualiza `loadConfig`:

```typescript
export function loadConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    claude: { oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN },
    whatsapp: {
      enabled: e.WHATSAPP_ENABLED,
      ownerNumber: e.WHATSAPP_OWNER_NUMBER ?? null,
    },
    evolution: {
      enabled: e.WHATSAPP_ENABLED,
      baseUrl: e.EVOLUTION_BASE_URL ?? null,
      apiKey: e.EVOLUTION_API_KEY ?? null,
      instance: e.EVOLUTION_INSTANCE,
    },
    telegram: {
      enabled: e.TELEGRAM_ENABLED,
      botToken: e.TELEGRAM_BOT_TOKEN ?? null,
      ownerChatId: e.TELEGRAM_OWNER_CHAT_ID ?? null,
    },
    workspaceDir: e.WORKSPACE_DIR,
    dataDir: e.DATA_DIR,
    webhookPort: e.WEBHOOK_PORT,
    webhookRequireApiKey: e.WEBHOOK_REQUIRE_APIKEY,
    sessionIdleHours: e.SESSION_IDLE_HOURS,
    logLevel: e.LOG_LEVEL,
    backend: e.WHIS_BACKEND,
  };
}
```

- [ ] **Step 3: Atualizar config.test.ts**

Edit `apps/worker/src/config.test.ts`. Adicionar bloco no fim:

```typescript
describe('channel flags', () => {
  const baseValid = {
    CLAUDE_CODE_OAUTH_TOKEN: 'abc',
    TELEGRAM_ENABLED: 'true',
    TELEGRAM_BOT_TOKEN: '123:ABC',
    TELEGRAM_OWNER_CHAT_ID: '5511999999999',
    WHATSAPP_ENABLED: 'false',
  };

  it('aceita só Telegram habilitado', () => {
    const c = loadConfig(baseValid);
    expect(c.telegram.enabled).toBe(true);
    expect(c.telegram.ownerChatId).toBe(5511999999999);
    expect(c.whatsapp.enabled).toBe(false);
  });

  it('aceita ambos habilitados', () => {
    const c = loadConfig({
      ...baseValid,
      WHATSAPP_ENABLED: 'true',
      EVOLUTION_BASE_URL: 'http://evolution-api:8080',
      EVOLUTION_API_KEY: 'k',
      WHATSAPP_OWNER_NUMBER: '5511999999999',
    });
    expect(c.telegram.enabled).toBe(true);
    expect(c.whatsapp.enabled).toBe(true);
  });

  it('rejeita ambos canais desabilitados', () => {
    expect(() =>
      loadConfig({ ...baseValid, TELEGRAM_ENABLED: 'false', WHATSAPP_ENABLED: 'false' }),
    ).toThrow(/pelo menos um canal/);
  });

  it('rejeita TELEGRAM_ENABLED sem TOKEN', () => {
    const broken = { ...baseValid };
    delete (broken as Record<string, string>).TELEGRAM_BOT_TOKEN;
    expect(() => loadConfig(broken)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('rejeita TELEGRAM_ENABLED sem OWNER_CHAT_ID', () => {
    const broken = { ...baseValid };
    delete (broken as Record<string, string>).TELEGRAM_OWNER_CHAT_ID;
    expect(() => loadConfig(broken)).toThrow(/TELEGRAM_OWNER_CHAT_ID/);
  });

  it('rejeita WHATSAPP_ENABLED sem EVOLUTION_BASE_URL', () => {
    expect(() =>
      loadConfig({
        ...baseValid,
        WHATSAPP_ENABLED: 'true',
        EVOLUTION_API_KEY: 'k',
        WHATSAPP_OWNER_NUMBER: '5511999999999',
      }),
    ).toThrow(/EVOLUTION_BASE_URL/);
  });
});
```

Atenção: tests existentes que assumiam `EVOLUTION_BASE_URL`/`EVOLUTION_API_KEY`/`WHATSAPP_OWNER_NUMBER` obrigatórios precisam de `WHATSAPP_ENABLED: 'true'` no payload válido. Atualizar `valid` no topo do file:

```typescript
const valid = {
  CLAUDE_CODE_OAUTH_TOKEN: 'token',
  WHATSAPP_ENABLED: 'true',                            // novo
  EVOLUTION_BASE_URL: 'http://evolution-api:8080',
  EVOLUTION_API_KEY: 'apikey',
  WHATSAPP_OWNER_NUMBER: '5511999999999',
  WEBHOOK_PORT: '8080',
  TELEGRAM_ENABLED: 'false',                           // novo: explicit pra evitar refine
};
```

- [ ] **Step 4: Run typecheck + tests**

```bash
pnpm --filter @whis/worker typecheck
pnpm --filter @whis/worker test config
```

Expected: typecheck PASS; tests PASS (incluindo os 6 novos do channel flags + os existentes adaptados).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/package.json apps/worker/src/config.ts apps/worker/src/config.test.ts pnpm-lock.yaml
git commit -m "feat(worker): adicionar grammy + flags por canal no config zod"
```

---

## Phase 3: Telegram normalize

### Task 2: `channels/telegram/normalize.ts`

**Files:**
- Create: `apps/worker/src/channels/telegram/normalize.ts`
- Create: `apps/worker/src/channels/telegram/normalize.test.ts`

- [ ] **Step 1: Escrever tests (FAIL)**

Create `apps/worker/src/channels/telegram/normalize.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { normalizeTelegramUpdate } from './normalize';

const ownerChatId = 123456789;

const validUpdate = (overrides: Record<string, unknown> = {}) => ({
  update_id: 1,
  message: {
    message_id: 42,
    chat: { id: ownerChatId, type: 'private', first_name: 'Gabriel' },
    from: { id: ownerChatId, is_bot: false, first_name: 'Gabriel' },
    date: Math.floor(Date.now() / 1000),
    text: 'oi',
    ...overrides,
  },
});

describe('normalizeTelegramUpdate', () => {
  it('returns IncomingMessage for valid DM from owner', () => {
    const msg = normalizeTelegramUpdate(validUpdate(), ownerChatId);
    expect(msg).not.toBeNull();
    expect(msg?.platform).toBe('telegram');
    expect(msg?.userId).toBe(`tg:${ownerChatId}`);
    expect(msg?.conversationId).toBe(`tg:${ownerChatId}`);
    expect(msg?.threadId).toBeNull();
    expect(msg?.text).toBe('oi');
    expect(msg?.messageRef).toBe('42');
    expect(msg?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns null for chat fora da whitelist', () => {
    const upd = validUpdate({ chat: { id: 999, type: 'private' } });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null for chat.type group', () => {
    const upd = validUpdate({ chat: { id: ownerChatId, type: 'group' } });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null for chat.type supergroup', () => {
    const upd = validUpdate({ chat: { id: ownerChatId, type: 'supergroup' } });
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null when message has no text (e.g., sticker)', () => {
    const upd = { update_id: 1, message: { message_id: 1, chat: { id: ownerChatId, type: 'private' }, from: { id: ownerChatId, is_bot: false, first_name: 'X' }, date: 0 } };
    expect(normalizeTelegramUpdate(upd, ownerChatId)).toBeNull();
  });

  it('returns null when text is empty string', () => {
    expect(normalizeTelegramUpdate(validUpdate({ text: '' }), ownerChatId)).toBeNull();
  });

  it('returns null when text is whitespace only', () => {
    expect(normalizeTelegramUpdate(validUpdate({ text: '   \n  ' }), ownerChatId)).toBeNull();
  });

  it('returns null for non-message updates (callback_query, etc)', () => {
    expect(normalizeTelegramUpdate({ update_id: 1, callback_query: {} }, ownerChatId)).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(normalizeTelegramUpdate(null, ownerChatId)).toBeNull();
    expect(normalizeTelegramUpdate({}, ownerChatId)).toBeNull();
    expect(normalizeTelegramUpdate({ update_id: 1 }, ownerChatId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

```bash
pnpm --filter @whis/worker test normalize
```

Expected: import error / module not found.

- [ ] **Step 3: Implementar**

Create `apps/worker/src/channels/telegram/normalize.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from '@/channels/types';

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: {
      id?: number;
      type?: string;
    };
    from?: {
      id?: number;
      is_bot?: boolean;
    };
    text?: string;
    date?: number;
  };
}

/**
 * Converte um Update da Bot API do Telegram em IncomingMessage.
 * Filtros: só DM (chat.type === 'private'), só do owner (chat.id === ownerChatId),
 * só texto. Returns null quando o update deve ser ignorado silenciosamente.
 */
export function normalizeTelegramUpdate(
  raw: unknown,
  ownerChatId: number,
): IncomingMessage | null {
  const upd = raw as TelegramUpdate | null;
  if (!upd?.message) return null;

  const m = upd.message;
  if (!m.chat || typeof m.chat.id !== 'number') return null;
  if (m.chat.type !== 'private') return null;
  if (m.chat.id !== ownerChatId) return null;

  if (typeof m.message_id !== 'number') return null;
  if (!m.text || typeof m.text !== 'string' || m.text.trim().length === 0) return null;

  return {
    platform: 'telegram',
    userId: `tg:${m.chat.id}`,
    conversationId: `tg:${m.chat.id}`,
    threadId: null,
    text: m.text,
    correlationId: randomUUID(),
    messageRef: String(m.message_id),
    raw,
  };
}
```

- [ ] **Step 4: Run test (PASS)**

```bash
pnpm --filter @whis/worker test normalize
```

Expected: 9 tests passing (validUpdate test + non-owner + group + supergroup + no-text + empty + whitespace + non-message + malformed × 3 cases counted as 1).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/channels/telegram/normalize.ts apps/worker/src/channels/telegram/normalize.test.ts
git commit -m "feat(channel): normalize Telegram Update → IncomingMessage com whitelist"
```

---

## Phase 4: Telegram format

### Task 3: `channels/telegram/format.ts`

**Files:**
- Create: `apps/worker/src/channels/telegram/format.ts`
- Create: `apps/worker/src/channels/telegram/format.test.ts`

- [ ] **Step 1: Escrever tests (FAIL)**

Create `apps/worker/src/channels/telegram/format.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { toTelegramMarkdownV2 } from './format';

describe('toTelegramMarkdownV2', () => {
  it('translates **bold** to *bold*', () => {
    expect(toTelegramMarkdownV2('hello **world**')).toBe('hello *world*');
  });

  it('translates *italic* to _italic_', () => {
    expect(toTelegramMarkdownV2('hello *world*')).toBe('hello _world_');
  });

  it('preserves inline `code` unchanged', () => {
    expect(toTelegramMarkdownV2('use `pnpm install`')).toBe('use `pnpm install`');
  });

  it('preserves fenced code blocks unchanged', () => {
    const input = 'before\n```\nfoo\n```\nafter';
    expect(toTelegramMarkdownV2(input)).toBe(input);
  });

  it('escapes special chars in plain text', () => {
    expect(toTelegramMarkdownV2('hello. world!')).toBe('hello\\. world\\!');
    expect(toTelegramMarkdownV2('a (b) c [d]')).toBe('a \\(b\\) c \\[d\\]');
    expect(toTelegramMarkdownV2('1 + 2 = 3')).toBe('1 \\+ 2 \\= 3');
  });

  it('escapes special chars but keeps formatting markers', () => {
    expect(toTelegramMarkdownV2('see **here** for details.')).toBe('see *here* for details\\.');
  });

  it('escapes special chars inside italic content', () => {
    // *italic.* → _italic\._
    expect(toTelegramMarkdownV2('this is *cool.*')).toBe('this is _cool\\._');
  });

  it('keeps content inside code blocks untouched (no escape)', () => {
    expect(toTelegramMarkdownV2('see `a.b!` now')).toBe('see `a\\.b\\!` now');
    // Note: inline code DOES need escape inside per MarkdownV2 spec, but backticks themselves are preserved
  });

  it('preserves text without markdown', () => {
    expect(toTelegramMarkdownV2('plain text')).toBe('plain text');
  });

  it('handles mixed bold + italic + code', () => {
    expect(toTelegramMarkdownV2('**bold** and *italic* and `code`')).toBe(
      '*bold* and _italic_ and `code`',
    );
  });

  it('handles bold containing dot', () => {
    expect(toTelegramMarkdownV2('**Hello.**')).toBe('*Hello\\.*');
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

```bash
pnpm --filter @whis/worker test format
```

Expected: import error.

- [ ] **Step 3: Implementar**

Create `apps/worker/src/channels/telegram/format.ts`:

```typescript
/**
 * Translates Claude-style markdown into Telegram MarkdownV2.
 *
 * - `**bold**`  → `*bold*`
 * - `*italic*`  → `_italic_`
 * - Inline `code` and fenced ``` blocks preservados (com escape interno).
 * - Caracteres especiais MarkdownV2 (`_*[]()~`>#+-=|{}.!`) recebem `\` em texto comum.
 *
 * Stages com placeholders ASCII (mesmo padrão do whatsapp/format.ts) — proteção
 * contra recursão entre passos. Tokens improváveis em texto humano.
 */
const MD_V2_SPECIAL = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function toTelegramMarkdownV2(input: string): string {
  // Stage 1: proteger fenced code blocks e inline code.
  const codePlaceholders: string[] = [];
  const protectCode = (match: string): string => {
    codePlaceholders.push(match);
    return `__WHIS_C_${codePlaceholders.length - 1}__`;
  };
  let s = input.replace(/```[\s\S]*?```/g, protectCode).replace(/`[^`\n]+`/g, protectCode);

  // Stage 2: extrair bold spans `**x**`.
  const boldContents: string[] = [];
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, content: string) => {
    boldContents.push(content);
    return `__WHIS_B_${boldContents.length - 1}__`;
  });

  // Stage 3: extrair italic spans `*x*`.
  const italicContents: string[] = [];
  s = s.replace(/\*([^*\n]+)\*/g, (_, content: string) => {
    italicContents.push(content);
    return `__WHIS_I_${italicContents.length - 1}__`;
  });

  // Stage 4: escape em todo o texto plano restante.
  s = s.replace(MD_V2_SPECIAL, '\\$1');

  // Stage 5: restaurar italic com escape interno.
  s = s.replace(/__WHIS_I_(\d+)__/g, (_, idx: string) => {
    const content = italicContents[Number(idx)] ?? '';
    return `_${escapeText(content)}_`;
  });

  // Stage 6: restaurar bold com escape interno.
  s = s.replace(/__WHIS_B_(\d+)__/g, (_, idx: string) => {
    const content = boldContents[Number(idx)] ?? '';
    return `*${escapeText(content)}*`;
  });

  // Stage 7: restaurar code blocks. Conteúdo de code também precisa escape MarkdownV2.
  s = s.replace(/__WHIS_C_(\d+)__/g, (_, idx: string) => {
    const block = codePlaceholders[Number(idx)] ?? '';
    return escapeCode(block);
  });

  return s;
}

function escapeText(s: string): string {
  return s.replace(MD_V2_SPECIAL, '\\$1');
}

/** Escape interno do conteúdo de inline `code` e fenced ``` blocks (preserva delimitadores). */
function escapeCode(block: string): string {
  if (block.startsWith('```')) {
    // Fenced block: ```...``` — não escapa conteúdo (Telegram aceita raw em ```code```).
    return block;
  }
  // Inline `code`: escapa caracteres especiais dentro mas mantém backticks.
  const inner = block.slice(1, -1);
  return `\`${inner.replace(/([\\`])/g, '\\$1').replace(MD_V2_SPECIAL, '\\$1')}\``;
}
```

- [ ] **Step 4: Run test (PASS)**

```bash
pnpm --filter @whis/worker test format
```

Expected: 11 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/channels/telegram/format.ts apps/worker/src/channels/telegram/format.test.ts
git commit -m "feat(channel): toTelegramMarkdownV2 com escape stage-based"
```

---

## Phase 5: Telegram adapter

### Task 4: `channels/telegram/adapter.ts`

**Files:**
- Create: `apps/worker/src/channels/telegram/adapter.ts`
- Create: `apps/worker/src/channels/telegram/adapter.test.ts`

- [ ] **Step 1: Escrever tests (FAIL)**

Create `apps/worker/src/channels/telegram/adapter.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from './adapter';

function buildBotMock() {
  const sendMessage = vi.fn(async () => ({ message_id: 999 }));
  const setMessageReaction = vi.fn(async () => true);
  const getMe = vi.fn(async () => ({ id: 1, username: 'whis_test_bot' }));
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const onHandler = vi.fn();
  const catchHandler = vi.fn();

  const bot = {
    api: { sendMessage, setMessageReaction, getMe },
    start,
    stop,
    on: (event: string, handler: unknown) => {
      onHandler(event, handler);
    },
    catch: (handler: unknown) => {
      catchHandler(handler);
    },
  };
  return { bot, sendMessage, setMessageReaction, getMe, start, stop, onHandler };
}

describe('TelegramChannel', () => {
  it('start() chama getMe antes de bot.start()', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot as never });
    const handler = vi.fn(async () => undefined);
    await ch.start(handler);
    expect(m.getMe).toHaveBeenCalledTimes(1);
    expect(m.start).toHaveBeenCalledTimes(1);
    expect(m.getMe.mock.invocationCallOrder[0]).toBeLessThan(m.start.mock.invocationCallOrder[0]);
  });

  it('send invoca sendMessage com parse_mode MarkdownV2', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot as never });
    await ch.start(vi.fn());
    const r = await ch.send(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '5' },
      'hello **world**',
    );
    expect(m.sendMessage).toHaveBeenCalledWith(
      'tg:42',
      'hello *world*',
      expect.objectContaining({ parse_mode: 'MarkdownV2' }),
    );
    expect(r.messageRef).toBe('999');
  });

  it('react invoca setMessageReaction com emoji mapeado', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot as never });
    await ch.start(vi.fn());
    await ch.react(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '7' },
      'eyes',
    );
    expect(m.setMessageReaction).toHaveBeenCalledWith(
      'tg:42',
      7,
      expect.objectContaining({ reaction: [{ type: 'emoji', emoji: '👀' }] }),
    );
  });

  it('unreact invoca setMessageReaction com array vazia', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot as never });
    await ch.start(vi.fn());
    await ch.unreact(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '7' },
      'eyes',
    );
    expect(m.setMessageReaction).toHaveBeenCalledWith(
      'tg:42',
      7,
      expect.objectContaining({ reaction: [] }),
    );
  });

  it('react com emoji desconhecido vira no-op', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot as never });
    await ch.start(vi.fn());
    await ch.react(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null, messageRef: '7' },
      'unknown_emoji',
    );
    expect(m.setMessageReaction).not.toHaveBeenCalled();
  });

  it('waitForReaction returns null (no-op MVP)', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot as never });
    await ch.start(vi.fn());
    const r = await ch.waitForReaction(
      { platform: 'telegram', conversationId: 'tg:42', threadId: null },
      ['eyes'],
      1000,
    );
    expect(r).toBeNull();
  });

  it('stop chama bot.stop()', async () => {
    const m = buildBotMock();
    const ch = new TelegramChannel({ ownerChatId: 1, makeBot: () => m.bot as never });
    await ch.start(vi.fn());
    await ch.stop();
    expect(m.stop).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

```bash
pnpm --filter @whis/worker test adapter
```

Expected: import error.

- [ ] **Step 3: Implementar**

Create `apps/worker/src/channels/telegram/adapter.ts`:

```typescript
import { Bot, type Context } from 'grammy';
import { createLogger } from '@whis/logger';
import type {
  Channel,
  IncomingMessage,
  MessageHandler,
  MessageTarget,
  ReactionEvent,
} from '@/channels/types';
import { toTelegramMarkdownV2 } from '@/channels/telegram/format';
import { normalizeTelegramUpdate } from '@/channels/telegram/normalize';

const logger = createLogger({ service: 'worker' });

const REACTION_EMOJI: Record<string, string> = {
  eyes: '👀',
  white_check_mark: '✅',
  warning: '⚠️',
};

export interface TelegramChannelOptions {
  /** Bot token from BotFather. Required when not using makeBot. */
  token?: string;
  /** Owner chat_id from telegram:setup helper. */
  ownerChatId: number;
  /** Test seam: returns a pre-built Bot mock. Production code passes `token` instead. */
  makeBot?: (token: string) => Bot;
}

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private bot: Bot;
  private handler: MessageHandler | null = null;

  constructor(private readonly opts: TelegramChannelOptions) {
    if (opts.makeBot) {
      this.bot = opts.makeBot(opts.token ?? '');
    } else if (opts.token) {
      this.bot = new Bot(opts.token);
    } else {
      throw new Error('TelegramChannel requires `token` or `makeBot`');
    }
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;

    // Healthcheck antes do polling — pega token inválido logo.
    try {
      const me = await this.bot.api.getMe();
      logger.info(
        { event: 'telegram_health_ok', botUsername: me.username, botId: me.id },
        'telegram reachable',
      );
    } catch (err) {
      logger.warn(
        { event: 'telegram_health_failed', err: String(err) },
        'telegram getMe failed',
      );
      // Não joga — segue tentando via polling.
    }

    this.bot.on('message:text', async (ctx: Context) => {
      const update = ctx.update;
      const msg = normalizeTelegramUpdate(update, this.opts.ownerChatId);
      if (!msg) {
        logger.info(
          { event: 'dm_ignored_non_owner', channel: 'telegram', chatId: ctx.chat?.id },
          'telegram message ignored (not owner or not private)',
        );
        return;
      }
      if (this.handler) {
        await this.handler(msg);
      }
    });

    this.bot.catch((err) => {
      logger.error(
        { event: 'telegram_polling_error', err: String(err.error ?? err) },
        'grammy bot error',
      );
    });

    // Long-polling em background (não bloqueia start() quando grammy 2.x).
    void this.bot.start();
  }

  async send(target: MessageTarget, text: string): Promise<{ messageRef: string }> {
    if (target.platform !== 'telegram') {
      throw new Error(`Unsupported platform: ${target.platform}`);
    }
    const formatted = toTelegramMarkdownV2(text);
    const result = await this.bot.api.sendMessage(target.conversationId, formatted, {
      parse_mode: 'MarkdownV2',
    });
    return { messageRef: String(result.message_id) };
  }

  async react(target: MessageTarget, emojiName: string): Promise<void> {
    if (!target.messageRef) return;
    const emoji = REACTION_EMOJI[emojiName];
    if (!emoji) {
      logger.warn(
        { event: 'unknown_reaction_name', channel: 'telegram', emojiName },
        'unknown reaction name',
      );
      return;
    }
    await this.bot.api.setMessageReaction(
      target.conversationId,
      Number(target.messageRef),
      { reaction: [{ type: 'emoji', emoji }] },
    );
  }

  async unreact(target: MessageTarget, _emojiName: string): Promise<void> {
    if (!target.messageRef) return;
    await this.bot.api.setMessageReaction(
      target.conversationId,
      Number(target.messageRef),
      { reaction: [] },
    );
  }

  async waitForReaction(
    _target: MessageTarget,
    _emojis: string[],
    _timeoutMs: number,
    _expectedUserId?: string,
  ): Promise<ReactionEvent | null> {
    return null;
  }

  async openDm(userId: string): Promise<string> {
    return userId;
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.handler = null;
    logger.info({ event: 'telegram_channel_stopped' }, 'telegram channel stopped');
  }
}
```

- [ ] **Step 4: Run test (PASS)**

```bash
pnpm --filter @whis/worker test adapter
```

Expected: 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/channels/telegram/adapter.ts apps/worker/src/channels/telegram/adapter.test.ts
git commit -m "feat(channel): TelegramChannel via grammy long-polling + reactions"
```

---

## Phase 6: AgentCore multi-canal

### Task 5: `wrapMessageContext` despacha por platform

**Files:**
- Modify: `apps/worker/src/agent/core.ts`
- Modify: `apps/worker/src/agent/core.test.ts`

- [ ] **Step 1: Refatorar core.ts**

Edit `apps/worker/src/agent/core.ts`. **Localizar** a chamada em `bind()`:

```typescript
const agentInput: AgentInput = {
  systemPrompt: this.opts.getSystemPrompt(),
  userMessage: wrapWithWhatsAppContext(message),
  // ...
```

**Substituir** `wrapWithWhatsAppContext` por `wrapMessageContext`:

```typescript
const agentInput: AgentInput = {
  systemPrompt: this.opts.getSystemPrompt(),
  userMessage: wrapMessageContext(message),
  // ...
```

**Adicionar** as funções (antes de `wrapWithWhatsAppContext`):

```typescript
/** @internal Exported for testing. Despacha por platform. */
export function wrapMessageContext(message: IncomingMessage): string {
  if (message.platform === 'whatsapp') return wrapWithWhatsAppContext(message);
  if (message.platform === 'telegram') return wrapWithTelegramContext(message);
  return message.text;
}

/** @internal Exported for testing. */
export function wrapWithTelegramContext(message: IncomingMessage): string {
  const lines = [
    '[telegram_context]',
    `chat_id: ${message.conversationId}`,
    `user_id: ${message.userId}`,
    `current_time: ${new Date().toISOString()}`,
    '[/telegram_context]',
    '',
    message.text,
  ];
  return lines.join('\n');
}
```

`wrapWithWhatsAppContext` permanece como está.

- [ ] **Step 2: Atualizar tests existentes**

Edit `apps/worker/src/agent/core.test.ts`. Localizar imports:

```typescript
import { AgentCore, wrapWithWhatsAppContext } from './core';
```

Trocar pra:

```typescript
import { AgentCore, wrapMessageContext, wrapWithTelegramContext, wrapWithWhatsAppContext } from './core';
```

Adicionar describe block no fim:

```typescript
describe('wrapMessageContext', () => {
  const baseMsg = (platform: string): IncomingMessage => ({
    platform,
    userId: 'u',
    conversationId: 'c',
    threadId: null,
    text: 'oi',
    correlationId: 'cid',
    messageRef: 'm',
    raw: {},
  });

  it('despacha pra wrapWithWhatsAppContext quando platform=whatsapp', () => {
    const out = wrapMessageContext(baseMsg('whatsapp'));
    expect(out).toContain('[whatsapp_context]');
  });

  it('despacha pra wrapWithTelegramContext quando platform=telegram', () => {
    const out = wrapMessageContext(baseMsg('telegram'));
    expect(out).toContain('[telegram_context]');
    expect(out).toContain('chat_id: c');
    expect(out).toContain('oi');
  });

  it('retorna texto cru pra platform desconhecida', () => {
    expect(wrapMessageContext(baseMsg('mock'))).toBe('oi');
  });
});

describe('AgentCore multi-canal', () => {
  it('mantém sessões isoladas entre canais com chatIds distintos', async () => {
    // Setup: SessionRepo real (in-memory db), backend mock retornando session_id por turno,
    // 2 channels fakes, dispatch 1 msg em cada e assertar upsert separado.
    const db = openDatabase(':memory:');
    runMigrations(db);
    const sessions = new SessionRepo(db);

    let turn = 0;
    const backend: AgentBackend = {
      name: 'mock',
      query: async () => ({ text: 'ok', toolCalls: [], sessionId: `sid-${++turn}` }),
    };

    const sent: { channel: string; text: string }[] = [];
    const makeChannel = (name: string): Channel => ({
      name,
      start: async () => undefined,
      send: async (target, text) => {
        sent.push({ channel: name, text });
        return { messageRef: 'r' };
      },
      react: async () => undefined,
      unreact: async () => undefined,
      waitForReaction: async () => null,
      openDm: async (id) => id,
      stop: async () => undefined,
    });

    const wa = makeChannel('whatsapp');
    const tg = makeChannel('telegram');

    const core = new AgentCore({
      backend,
      workspaceDir: '/tmp',
      getSystemPrompt: () => 'sys',
      sessions,
      sessionIdleMs: 6 * 3_600_000,
    });

    const handleWa = core.bind(wa);
    const handleTg = core.bind(tg);

    await handleWa({
      platform: 'whatsapp',
      userId: '5511999999999@s.whatsapp.net',
      conversationId: '5511999999999@s.whatsapp.net',
      threadId: null,
      text: 'oi wa',
      correlationId: 'cid-wa',
      messageRef: 'mref-wa',
      raw: {},
    });

    await handleTg({
      platform: 'telegram',
      userId: 'tg:5511999999999',
      conversationId: 'tg:5511999999999',
      threadId: null,
      text: 'oi tg',
      correlationId: 'cid-tg',
      messageRef: '42',
      raw: {},
    });

    const waSession = sessions.get('5511999999999@s.whatsapp.net');
    const tgSession = sessions.get('tg:5511999999999');
    expect(waSession?.sessionId).toBe('sid-1');
    expect(tgSession?.sessionId).toBe('sid-2');
    expect(waSession?.sessionId).not.toBe(tgSession?.sessionId);

    closeDatabase(db);
  });
});
```

Imports adicionais necessários no topo do test file:

```typescript
import { closeDatabase, openDatabase, runMigrations, SessionRepo } from '@whis/storage';
import type { AgentBackend } from './types';
import type { Channel, IncomingMessage } from '@/channels/types';
```

- [ ] **Step 3: Adicionar `channel` field em todos os logs do AgentCore**

Edit `apps/worker/src/agent/core.ts`. Localizar cada `logger.info(...)` e `logger.error(...)` dentro de `bind()` e `reportFailure()`. Adicionar `channel: message.platform` (ou `target.platform` em `reportFailure`) ao primeiro argumento.

**Logs a atualizar:**

```typescript
// session_resumed
logger.info(
  {
    event: 'session_resumed',
    channel: message.platform,                       // novo
    correlationId: message.correlationId,
    chatId,
    sessionId: resumeSessionId,
  },
  'resuming session',
);

// session_created
logger.info(
  {
    event: 'session_created',
    channel: message.platform,                       // novo
    correlationId: message.correlationId,
    chatId,
    sessionId: output.sessionId,
  },
  'session created',
);

// response_sent
logger.info(
  { event: 'response_sent', channel: message.platform, correlationId: message.correlationId },
  'response sent',
);

// session_resume_failed
logger.warn(
  {
    event: 'session_resume_failed',
    channel: message.platform,
    correlationId: message.correlationId,
    chatId,
    staleSessionId: resumeSessionId,
  },
  'stale session, starting fresh',
);
```

`reportFailure` precisa receber `platform` por parâmetro:

```typescript
private async reportFailure(
  channel: Channel,
  target: MessageTarget,
  correlationId: string,
  error: unknown,
): Promise<void> {
  const reply = translateError(error);
  await channel.send(target, reply);
  await safe(() => channel.unreact(target, 'eyes'));
  logger.error(
    { event: 'handler_failed', channel: target.platform, correlationId, err: String(error) },
    'core handler failed',
  );
}
```

(`target.platform` já existe no MessageTarget — basta usar.)

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @whis/worker test agent/core
```

Expected: tests existentes passam (sem regressão) + 3 novos do `wrapMessageContext` + 1 novo de session isolation = 4 novos.

Tests existentes que assertam shape de log podem precisar ajuste (`channel` field novo). Se algum test falhar, atualizar o `expect.objectContaining(...)` correspondente pra incluir `channel`.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/agent/core.ts apps/worker/src/agent/core.test.ts
git commit -m "feat(agent): wrapMessageContext + channel field em todos os event logs"
```

---

## Phase 7: Composition root

### Task 6: `index.ts` com lista de canais condicional

**Files:**
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Refatorar boot pra lista de canais**

Edit `apps/worker/src/index.ts`. Substituir o bloco que vai do comentário `// Wrap channel.send antes de start()` até `await channel.start(async (msg) => { ... })` por composição condicional.

**Antes** (atual):
```typescript
const channel = new WhatsAppChannel({ client: evolutionClient });
// ... wrap channel.send ...
const handleMessage = core.bind(channel);
await channel.start(...);
```

**Depois:**

```typescript
import type { Channel } from '@/channels/types';
import { TelegramChannel } from '@/channels/telegram/adapter';

// ... resto do main() até logo após `bootLogger.info({ event: 'backend_selected', ... })` ...

const core = new AgentCore({
  backend,
  workspaceDir: config.workspaceDir,
  getSystemPrompt: () => promptHolder.value,
  sessions,
  sessionIdleMs: config.sessionIdleHours * 3_600_000,
});

const channels: Channel[] = [];

// --- Telegram channel ---
if (config.telegram.enabled && config.telegram.botToken && config.telegram.ownerChatId !== null) {
  const telegram = new TelegramChannel({
    token: config.telegram.botToken,
    ownerChatId: config.telegram.ownerChatId,
  });

  // Audit outbound messages.
  const originalSend = telegram.send.bind(telegram);
  telegram.send = async (target, text) => {
    const result = await originalSend(target, text);
    messages.insert({
      chatId: target.conversationId,
      direction: 'out',
      text,
      correlationId: 'outbound',
      messageRef: result.messageRef,
      at: Date.now(),
    });
    return result;
  };

  const handle = core.bind(telegram);
  await telegram.start(async (msg) => {
    messages.insert({
      chatId: msg.conversationId,
      direction: 'in',
      text: msg.text,
      correlationId: msg.correlationId,
      messageRef: msg.messageRef,
      at: Date.now(),
    });
    await handle(msg);
  });

  channels.push(telegram);
}

// --- WhatsApp channel ---
// Mantemos referência tipada do whatsapp pra usar em /webhook/whatsapp e /health.
let whatsappChannel: WhatsAppChannel | null = null;
let evolutionClientForHealth: EvolutionClient | null = null;

if (
  config.whatsapp.enabled &&
  config.evolution.baseUrl &&
  config.evolution.apiKey &&
  config.whatsapp.ownerNumber
) {
  const evolutionClient = new EvolutionClient({
    baseUrl: config.evolution.baseUrl,
    apiKey: config.evolution.apiKey,
    instance: config.evolution.instance,
  });
  const evolutionOk = await evolutionClient.ping();
  if (evolutionOk) bootLogger.info({ event: 'evolution_health_ok' });
  else bootLogger.warn({ event: 'evolution_health_failed' }, 'evolution not reachable at boot');

  const whatsapp = new WhatsAppChannel({ client: evolutionClient });
  const originalSend = whatsapp.send.bind(whatsapp);
  whatsapp.send = async (target, text) => {
    const result = await originalSend(target, text);
    messages.insert({
      chatId: target.conversationId,
      direction: 'out',
      text,
      correlationId: 'outbound',
      messageRef: result.messageRef,
      at: Date.now(),
    });
    return result;
  };

  const handle = core.bind(whatsapp);
  await whatsapp.start(async (msg) => {
    messages.insert({
      chatId: msg.conversationId,
      direction: 'in',
      text: msg.text,
      correlationId: msg.correlationId,
      messageRef: msg.messageRef,
      at: Date.now(),
    });
    await handle(msg);
  });

  channels.push(whatsapp);
  whatsappChannel = whatsapp;
  evolutionClientForHealth = evolutionClient;
}

if (channels.length === 0) {
  throw new Error('Nenhum canal habilitado: setar TELEGRAM_ENABLED=true ou WHATSAPP_ENABLED=true');
}
```

- [ ] **Step 2: Atualizar webhook server boot pra refletir multi-canal**

Logo abaixo da composição dos canais:

```typescript
const app = buildWebhookApp({
  ownerNumber: config.whatsapp.ownerNumber ?? '',
  expectedApiKey:
    config.webhookRequireApiKey && config.evolution.apiKey ? config.evolution.apiKey : null,
  onMessage: async (msg) => {
    // Webhook só faz sentido pra WhatsApp. Se dormante, no-op.
    if (whatsappChannel) await whatsappChannel.dispatch(msg);
  },
  healthCheck: async () => ({
    dbOpen: true,
    channels: {
      telegram: { enabled: config.telegram.enabled },
      whatsapp: {
        enabled: config.whatsapp.enabled,
        ping: evolutionClientForHealth ? await evolutionClientForHealth.ping() : false,
      },
    },
  }),
  isOwnMessage: (id) => whatsappChannel?.isOwnMessage(id) ?? false,
});
```

> **Nota:** o `WebhookDeps` interface vai precisar atualizar pra aceitar a forma nova de `healthCheck`. Isso é Task 9. Por enquanto, deixa o código compilando — adapte temporariamente `healthCheck` pra retornar o shape antigo se necessário até Task 9.

- [ ] **Step 3: Atualizar shutdown pra parar todos os canais**

No bloco `shutdown`:

```typescript
const shutdown = async (signal: string): Promise<void> => {
  bootLogger.info({ event: 'shutdown', signal });
  try { watcher.stop(); } catch { /* */ }
  for (const ch of channels) {
    try { await ch.stop(); } catch { /* */ }
  }
  try { server.close(); } catch { /* */ }
  try { closeDatabase(db); } catch { /* */ }
  process.exit(0);
};
```

- [ ] **Step 4: Build e testar resolução em Node**

```bash
rm -rf apps/worker/dist
pnpm --filter @whis/worker build
node --input-type=module -e "import('./apps/worker/dist/index.js').catch(e => { console.error(e.message); process.exit(0); })"
```

Expected: bundle resolve (pode falhar em validação de env, OK — significa que imports estão corretos).

- [ ] **Step 5: Run quality-gate**

```bash
pnpm run quality-gate
```

Expected: 11 tasks ok, todos os tests verdes.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat(worker): composition root com lista condicional de canais"
```

---

## Phase 8: Setup helper

### Task 7: `infra/setup-telegram.ts` + script `telegram:setup`

**Files:**
- Create: `infra/setup-telegram.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Criar script**

Create `infra/setup-telegram.ts`:

```typescript
#!/usr/bin/env -S tsx
// Helper one-time pra descobrir TELEGRAM_OWNER_CHAT_ID.
// Lê TELEGRAM_BOT_TOKEN do profile/.env, faz getMe, espera primeira mensagem
// pelo bot via long-polling, imprime chat_id e encerra.

import { readFileSync } from 'node:fs';
import { Bot } from 'grammy';

function readEnvFromFile(path: string): Record<string, string> {
  try {
    const raw = readFileSync(path, 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const env = readEnvFromFile('profile/.env');
const token = env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error(
    'TELEGRAM_BOT_TOKEN vazio em profile/.env (ou variável de ambiente).\n' +
      '1. Abre @BotFather no Telegram\n' +
      '2. /newbot, escolhe nome e username\n' +
      '3. Cola o token retornado em profile/.env como TELEGRAM_BOT_TOKEN=...\n' +
      '4. Roda este script de novo.',
  );
  process.exit(1);
}

const bot = new Bot(token);

const TIMEOUT_MS = 5 * 60 * 1000; // 5min
const timeout = setTimeout(() => {
  console.error('\nTimeout: nenhuma mensagem recebida em 5min. Abortando.');
  void bot.stop().finally(() => process.exit(1));
}, TIMEOUT_MS);

async function main(): Promise<void> {
  const me = await bot.api.getMe();
  console.log(`Bot pareado: @${me.username} (id ${me.id})`);
  console.log('\nAgora abre o Telegram e manda /start (ou qualquer mensagem) pro teu bot.\n');

  bot.on('message', async (ctx) => {
    clearTimeout(timeout);
    const chatId = ctx.chat.id;
    console.log(`\nDescoberto!\n`);
    console.log(`TELEGRAM_OWNER_CHAT_ID=${chatId}`);
    console.log(`\nCola essa linha em profile/.env e roda \`pnpm run docker:up\`.`);
    try {
      await ctx.reply('Capturado teu chat_id. Volta pro terminal pra continuar o setup.');
    } catch {
      /* não-crítico */
    }
    await bot.stop();
    process.exit(0);
  });

  bot.catch((err) => {
    console.error('\nErro do grammy:', err.error ?? err);
    clearTimeout(timeout);
    process.exit(1);
  });

  await bot.start();
}

void main().catch((err) => {
  clearTimeout(timeout);
  console.error('Falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Adicionar script no package.json (root)**

Edit `package.json` (root). Em `scripts`:

```json
"telegram:setup": "tsx infra/setup-telegram.ts",
```

Logo abaixo do `evolution:setup`.

`tsx` já é devDep de `apps/worker/package.json`; pra rodar do root, adiciona como devDep do root também:

```bash
pnpm add -D -w tsx
```

- [ ] **Step 3: Smoke local**

Pré-requisito: criar bot no @BotFather e ter token. Cola em `profile/.env` (ou exporta como env).

```bash
pnpm run telegram:setup
```

Expected (sem token): erro com instruções claras + exit 1.
Expected (com token): "Bot pareado: @user. Manda /start..." + bot responde no chat após user mandar mensagem + imprime `TELEGRAM_OWNER_CHAT_ID=<n>` + sai 0.

- [ ] **Step 4: Commit**

```bash
git add infra/setup-telegram.ts package.json pnpm-lock.yaml
git commit -m "feat(infra): pnpm telegram:setup pra descobrir OWNER_CHAT_ID"
```

---

## Phase 9: Compose profiles

### Task 8: `profiles: [whatsapp]` no docker-compose

**Files:**
- Modify: `infra/docker-compose.yml`

- [ ] **Step 1: Adicionar profiles**

Edit `infra/docker-compose.yml`. Em `postgres`:

```yaml
postgres:
  profiles: [whatsapp]
  image: postgres:16-alpine
  # ... resto inalterado ...
```

Em `evolution-api`:

```yaml
evolution-api:
  profiles: [whatsapp]
  image: evoapicloud/evolution-api:v2.3.7
  # ... resto inalterado ...
```

`whis-worker` **sem** `profiles:` — fica no profile default, sobe sempre.

- [ ] **Step 2: Validar compose**

```bash
docker compose -f infra/docker-compose.yml --project-directory . config > /dev/null
echo "OK"
```

Expected: sem erro de YAML.

```bash
docker compose -f infra/docker-compose.yml --project-directory . config --profiles
```

Expected: lista `whatsapp`.

- [ ] **Step 3: Smoke (sem flag, só worker)**

```bash
docker compose -f infra/docker-compose.yml --project-directory . up -d
docker compose -f infra/docker-compose.yml --project-directory . ps
```

Expected: só `whis-worker-1` listado, postgres+evolution não criados.

- [ ] **Step 4: Smoke (com flag, todos)**

```bash
docker compose -f infra/docker-compose.yml --project-directory . down
docker compose -f infra/docker-compose.yml --project-directory . --profile whatsapp up -d
docker compose -f infra/docker-compose.yml --project-directory . ps
```

Expected: 3 containers (worker + postgres + evolution).

- [ ] **Step 5: Cleanup**

```bash
docker compose -f infra/docker-compose.yml --project-directory . down
```

- [ ] **Step 6: Commit**

```bash
git add infra/docker-compose.yml
git commit -m "build(compose): postgres+evolution-api em profile [whatsapp] (dormente default)"
```

---

## Phase 10: /health endpoint

### Task 9: `/health` retorna mapa de canais

**Files:**
- Modify: `apps/worker/src/webhook/server.ts`
- Modify: `apps/worker/src/webhook/server.test.ts`

- [ ] **Step 1: Atualizar interface WebhookDeps**

Edit `apps/worker/src/webhook/server.ts`. Substituir o type da `healthCheck`:

```typescript
export interface ChannelHealth {
  enabled: boolean;
  /** Optional liveness ping (only present pra canais que suportam). */
  ping?: boolean;
}

export interface WebhookDeps {
  ownerNumber: string;
  expectedApiKey: string | null;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  healthCheck: () => Promise<{ dbOpen: boolean; channels: Record<string, ChannelHealth> }>;
  isOwnMessage?: (id: string) => boolean;
}
```

Atualizar handler do `/health`:

```typescript
app.get('/health', async (c) => {
  const h = await deps.healthCheck();
  const status = h.dbOpen ? 'ok' : 'degraded';
  return c.json(
    { status, dbOpen: h.dbOpen, channels: h.channels, uptime: process.uptime() },
    h.dbOpen ? 200 : 503,
  );
});
```

- [ ] **Step 2: Atualizar tests**

Edit `apps/worker/src/webhook/server.test.ts`. Localizar tests existentes do `/health` e atualizar `healthCheck` mock pra retornar a nova shape:

```typescript
const buildDeps = (overrides: Partial<WebhookDeps> = {}): WebhookDeps => ({
  ownerNumber: '5511999999999',
  expectedApiKey: null,
  onMessage: vi.fn(async () => undefined),
  healthCheck: vi.fn(async () => ({
    dbOpen: true,
    channels: {
      telegram: { enabled: true, ping: true },
      whatsapp: { enabled: false },
    },
  })),
  ...overrides,
});
```

Adicionar test novo:

```typescript
it('GET /health retorna mapa de canais', async () => {
  const app = buildWebhookApp(buildDeps());
  const res = await app.request('/health');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.channels.telegram).toEqual({ enabled: true, ping: true });
  expect(body.channels.whatsapp).toEqual({ enabled: false });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @whis/worker test webhook
```

Expected: PASS (incluindo o novo).

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/webhook/server.ts apps/worker/src/webhook/server.test.ts
git commit -m "feat(webhook): /health retorna estado por canal (telegram + whatsapp)"
```

---

## Phase 11: Docs

### Task 10: AGENTS.md, SMOKE.md, .env.example

**Files:**
- Modify: `AGENTS.md`
- Modify: `SMOKE.md`
- Modify: `profile/.env.example`

- [ ] **Step 1: profile/.env.example**

Edit `profile/.env.example`. Reorganizar pra deixar claro o "duo de canais". Logo após `CLAUDE_CODE_OAUTH_TOKEN=`:

```bash
# === Canais — pelo menos um deve estar habilitado ===

# Telegram (recomendado pra setup pessoal sem chip dedicado)
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=                       # @BotFather → /newbot
TELEGRAM_OWNER_CHAT_ID=                   # `pnpm run telegram:setup`

# WhatsApp (dormente default — flipa pra true quando comprar chip dedicado)
WHATSAPP_ENABLED=false
```

Manter o resto (`EVOLUTION_*`, `WHATSAPP_OWNER_NUMBER`, `DATABASE_*`, etc) inalterado mas com comentário no topo do bloco:

```bash
# Vars do bloco abaixo são ignoradas se WHATSAPP_ENABLED=false.
# Subir Evolution+Postgres exige `pnpm run docker:up --profile whatsapp`.
```

- [ ] **Step 2: AGENTS.md tabela de comandos**

Edit `AGENTS.md`. Na tabela de comandos, adicionar:

```markdown
| `pnpm run telegram:setup` | Helper one-time pra descobrir TELEGRAM_OWNER_CHAT_ID. |
| `pnpm run docker:up --profile whatsapp` | Sobe worker + Evolution + Postgres (dual-canal ativo). |
```

Logo após a linha do `evolution:setup`.

- [ ] **Step 3: SMOKE.md — nova seção**

Edit `SMOKE.md`. Adicionar antes da seção "## 11. Quando o smoke passar":

````markdown
## Setup Telegram (default canal do MVP)

1. **Cria o bot no Telegram:**
   - Abre `@BotFather` no app
   - Manda `/newbot` → escolhe nome (ex: `Whis`) e username único (ex: `whis_gabriel_bot`)
   - Cola o token retornado em `profile/.env` na linha `TELEGRAM_BOT_TOKEN=`

2. **Descobre teu chat_id (no Git Bash ou PowerShell):**
   ```bash
   pnpm run telegram:setup
   ```
   Script imprime `Bot pareado: @nome_do_bot`. Aí abre o chat com o bot no app, manda `/start`. Script captura, imprime `TELEGRAM_OWNER_CHAT_ID=<numero>`, encerra.

3. **Cola** o `TELEGRAM_OWNER_CHAT_ID=<numero>` em `profile/.env`.

4. `pnpm run docker:up` (sem --profile whatsapp). Aguarda logs `telegram_health_ok` + `whis_online`.

5. Manda `oi` no chat com o bot. Whis responde com 👀 + texto.

## Modo dual (Telegram + WhatsApp simultâneos, futuro)

Quando tiver chip dedicado WhatsApp pareado:

1. Em `profile/.env`: `WHATSAPP_ENABLED=true`. Mantém `TELEGRAM_ENABLED=true`.
2. `pnpm run docker:up --profile whatsapp` — sobe os 3 containers.
3. Smoke S1 do WhatsApp + smoke Telegram em paralelo.
````

Adicionar 2-3 linhas na tabela de troubleshooting (seção 10):

```markdown
| `telegram_health_failed` ao boot | Token inválido ou rede sem outbound HTTPS. Confere `TELEGRAM_BOT_TOKEN` em `profile/.env`. Pra novo token: BotFather → `/newtoken` ou `/revoke` + cria de novo. |
| Bot mudo (não responde no Telegram) | Confere `TELEGRAM_OWNER_CHAT_ID` em `profile/.env` — se for outro chat_id, log `dm_ignored_non_owner` aparece. Re-roda `pnpm run telegram:setup`. |
| `409 Conflict` nos logs Telegram | Outra instância do worker rodando com mesmo token. Mata a outra. |
```

- [ ] **Step 4: Commit**

```bash
git add profile/.env.example AGENTS.md SMOKE.md
git commit -m "docs: setup Telegram em SMOKE.md + flags por canal em .env.example"
```

---

## Phase 12: Smoke manual

### Task 11: Smoke do Telegram

**Purpose:** Executar T1 (setup), T2 (caminho feliz), T3 (não-owner). Documentar pass.

**Files:** nenhum a criar até a documentação final.

- [ ] **Step 1: Executar T1 (setup completo)**

Seguir os passos da seção "Setup Telegram" do SMOKE.md — criar bot no @BotFather, rodar `pnpm run telegram:setup`, coletar `TELEGRAM_OWNER_CHAT_ID`, atualizar `profile/.env`.

- [ ] **Step 2: Executar T2 (caminho feliz)**

```bash
pnpm run docker:up
pnpm run docker:logs
```

Aguarda `telegram_health_ok` + `whis_online`. Manda `oi` no chat com o bot.

**Esperado:**
- 👀 reage em ~3s.
- Resposta personalizada do `hello-world` em PT-BR.
- 👀 sai.
- Logs mostram sequência com `channel: 'telegram'`: `message_received → session_created → backend_started → backend_completed → response_sent`.

- [ ] **Step 3: Executar T3 (não-owner — opcional, se tiver outra conta Telegram)**

Manda mensagem do bot a partir de outra conta Telegram. Espera log `dm_ignored_non_owner` com `channel: 'telegram'`. Sem resposta.

- [ ] **Step 4: Anotar achados**

Se algum success criterion falhar, criar issue/task de fix antes de marcar concluído.

- [ ] **Step 5: Escrever smoke-results.md**

Create `docs/specs/0002-telegram-channel/smoke-results.md`:

```markdown
---
feature: telegram-channel
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-MM-DD
---
# Telegram Channel — Smoke Test Results

**Data:** 2026-MM-DD
**Executor:** Gabriel

## Success Criteria observados

- [x] T1: setup BotFather + telegram:setup + cola chat_id → boot OK
- [x] T2: oi → resposta hello-world em <30s steady, 👀 on/off
- [ ] T3: não-owner ignorado (testado se tinha outra conta à mão)
- [ ] T4: dual-canal ativo (deferido pra quando comprar chip)
- [x] Logs com `channel: telegram` em todos os events do AgentCore
- [x] /health retorna `{ channels: { telegram: { enabled: true, ping: true }, whatsapp: { enabled: false } } }`
- [x] quality-gate verde com 70+ tests

## Status

Spec 0002 shipped.
```

- [ ] **Step 6: Flipar status da spec 0002**

Edit `docs/specs/0002-telegram-channel/spec.md`:
```diff
-status: draft
+status: shipped
-shipped: null
+shipped: 2026-MM-DD
```

- [ ] **Step 7: Commit**

```bash
git add docs/specs/0002-telegram-channel/spec.md docs/specs/0002-telegram-channel/smoke-results.md
git commit -m "docs(smoke): Telegram channel shipped — Phase 12 fechada"
```

---

## Resumo

**Total:** 12 tasks distribuídas em 12 fases.

Cada task termina em commit. Frequent commits dentro de tasks complexas. Quality gate (`pnpm run quality-gate`) deve passar antes de cada commit em tasks com código.

**Caminho mais curto pro primeiro `oi` no Telegram:** Tasks 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 9 → 10 → 11. Task 8 (compose profiles) pode ser feita depois — sem ela, postgres+evolution sobem com worker, mas Telegram funciona mesmo assim. Apenas custo de RAM.
