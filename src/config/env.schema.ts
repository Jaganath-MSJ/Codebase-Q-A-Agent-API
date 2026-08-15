import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GOOGLE_API_KEY: z.string().optional().default(''),
  GROQ_API_KEY: z.string().optional().default(''),
  EMBEDDING_PROVIDER: z.enum(['local', 'gemini']).default('local'),
  CHAT_PROVIDER: z.enum(['gemini', 'groq']).default('gemini'),
  DATA_DIR: z.string().default('./data'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default('development'),
  LLM_CACHE: z.enum(['on', 'off']).default('on'),
  // 32 random bytes, base64 — decoded and length-checked in credentials/crypto.util.ts,
  // not here, since that's where the "must decode to exactly 32 bytes" reasoning lives.
  CREDENTIAL_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
