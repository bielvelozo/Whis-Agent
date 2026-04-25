// apps/worker/src/config.ts
import { z } from 'zod';

const schema = z.object({
  CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().min(1).default('whis'),
  WHATSAPP_OWNER_NUMBER: z.string().regex(/^\d{10,15}$/, {
    message: 'must be digits only (e.g. 5511999999999)',
  }),
  WORKSPACE_DIR: z.string().default('/app/context'),
  DATA_DIR: z.string().default('/app/data'),
  WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SESSION_IDLE_HOURS: z.coerce.number().int().min(1).max(168).default(6),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  WHIS_BACKEND: z.enum(['claude-code', 'mock']).default('claude-code'),
});

export interface Config {
  claude: { oauthToken: string };
  evolution: { baseUrl: string; apiKey: string; instance: string };
  whatsapp: { ownerNumber: string };
  workspaceDir: string;
  dataDir: string;
  webhookPort: number;
  sessionIdleHours: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  backend: 'claude-code' | 'mock';
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    claude: { oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN },
    evolution: { baseUrl: e.EVOLUTION_BASE_URL, apiKey: e.EVOLUTION_API_KEY, instance: e.EVOLUTION_INSTANCE },
    whatsapp: { ownerNumber: e.WHATSAPP_OWNER_NUMBER },
    workspaceDir: e.WORKSPACE_DIR,
    dataDir: e.DATA_DIR,
    webhookPort: e.WEBHOOK_PORT,
    sessionIdleHours: e.SESSION_IDLE_HOURS,
    logLevel: e.LOG_LEVEL,
    backend: e.WHIS_BACKEND,
  };
}
