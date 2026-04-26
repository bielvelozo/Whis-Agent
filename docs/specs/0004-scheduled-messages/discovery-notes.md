---
feature: scheduled-messages
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-04-26
---
# Discovery — Scheduled Messages (0004)

**Data:** 2026-04-26

## 1. cron-parser

**Versão instalada:** `5.5.0` (não `^4` como inicialmente assumido na plan).

**Deps:** `luxon@^3.7.1` (única transitive — pure JS, sem nativas).

**Engines:** Node ≥18 (compatível com nosso Node 24).

**API confirmada (v5):**

```ts
import { CronExpressionParser } from 'cron-parser';

const cron = CronExpressionParser.parse('0 8 * * *', {
  tz: 'America/Sao_Paulo',
  currentDate: new Date(),
});
const nextDate = cron.next();   // returns CronDate
const ms = nextDate.getTime();  // ms timestamp
```

**Diferenças vs v4 (que a plan original assumiu):**
- v4 usava `cronParser.parseExpression()` como função.
- v5 usa `CronExpressionParser.parse()` como método estático de classe.
- Ambas aceitam `{ tz, currentDate }`. Output (`CronDate`) compatível.

**Validação:**
- Cron malformado (`'0 25 * * *'`) lança Error com message descritivo. ✅
- Timezone `'America/Sao_Paulo'` aceito. ✅
- `currentDate: new Date(from)` permite calcular next a partir de timestamp arbitrário. ✅

**Veredito:** OK. Wrapper `cron.ts` usa `CronExpressionParser.parse()`. Código nas Tasks 2/4/5 ajustado pra refletir a API real.

## 2. createSdkMcpServer

**Confirmado exportado** de `@anthropic-ai/claude-agent-sdk@^0.2.119`.

**Signature:**

```ts
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;

declare type CreateSdkMcpServerOptions = {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
};
```

**Helper `tool()`:**

```ts
export declare function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  _extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean },
): SdkMcpToolDefinition<Schema>;
```

**Detalhes importantes:**
- `_inputSchema` é `ZodRawShape` (objeto literal `{ field: z.string() }`), **NÃO** `z.object({...})`. SDK aceita Zod 3 e Zod 4 (já temos Zod 4 como dep direta).
- Handler retorna `Promise<CallToolResult>` do `@modelcontextprotocol/sdk/types.js`. Shape: `{ content: [{ type: 'text', text: string }] }`.
- O SDK injeta o server automaticamente no slot `mcpServers` quando passado via `inProcessMcpServers` no `ClaudeCodeBackend` (já cabeado, ver `claude-code.ts:168 buildMcpServers`).

**Veredito:** OK. Tools.ts da Task 5 segue o snippet da plan (precisa ajustar import + chamada do `tool()` pra corresponder à signature real — já corrigido na implementação).

## 3. CallToolResult

```ts
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// shape canônica: { content: Array<{ type: 'text', text: string } | other content types> }
```

Pra retornar JSON estruturado (pra LLM parsear), usar:

```ts
{ content: [{ type: 'text', text: JSON.stringify(result) }] }
```

## 4. Loop guard pra schedule_create

`tool()` handler recebe `extra: unknown` como segundo arg. Não há contrato documentado de o que vem em `extra` — pode incluir caller info ou não. **Decisão:** loop guard implementado via campo opcional `callerUserId` no input schema da própria tool. SOUL.md instrui Whis a NUNCA preencher esse campo. Implementação adicional defensiva: tool retorna erro se receber esse valor (system:scheduler nunca poderia chamar via Claude porque o agent só roda com prompt humano).

## Veredito geral

Pronto pra prosseguir Tasks 1-9. Ajustes vs plan original:
- `cron-parser@^5` (não `^4`).
- API: `CronExpressionParser.parse()` (não `cronParser.parseExpression()`).
- `tool()` schema é `ZodRawShape` literal (não `z.object`).
