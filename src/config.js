import { resolve } from 'node:path';

export function readConfig(env = process.env) {
  const provider = env.AGENT_PROVIDER || 'demo';
  if (!['demo', 'openai'].includes(provider)) throw new Error('AGENT_PROVIDER must be demo or openai');
  if (provider === 'openai' && !env.OPENAI_API_KEY?.trim()) throw new Error('OpenAI mode requires OPENAI_API_KEY in .env');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  return {
    provider,
    apiKey: env.OPENAI_API_KEY?.trim(),
    model: env.OPENAI_MODEL || 'gpt-4.1-mini',
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: resolve(env.DATA_DIR || './data'),
    maxSteps: 12,
  };
}
