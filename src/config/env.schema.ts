import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  GOOGLE_API_KEY: z.string().optional().default(''),
  EMBEDDING_PROVIDER: z.enum(['local', 'gemini']).default('local'),
  CHAT_PROVIDER: z.enum(['gemini', 'groq']).default('gemini'),
  DATA_DIR: z.string().default('./data'),
  PORT: z.coerce.number().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
