import { createApp } from './app.js';
import { FixedClock, timestamp } from '../domain/time.js';
import { RightCodesModel, UnconfiguredModel } from '../assistant/model.js';
const key = process.env.AIRLINE_MODEL_API_KEY,
  base = process.env.AIRLINE_MODEL_BASE_URL;
if (process.env.AIRLINE_MODEL && process.env.AIRLINE_MODEL !== 'gpt-5.6-sol')
  throw new Error('Only the approved gpt-5.6-sol model is enabled.');
const frozen = process.env.AIRLINE_FIXED_TIME
  ? timestamp(Date.parse(process.env.AIRLINE_FIXED_TIME))
  : null;
const service = await createApp({
  filename: process.env.AIRLINE_DB,
  clock: frozen ? new FixedClock(frozen) : undefined,
  frozenClock: !!frozen,
  serviceTrial: process.env.AIRLINE_SERVICE_TRIAL === '1',
  model: key && base ? new RightCodesModel(key, base) : new UnconfiguredModel(),
});
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
await service.app.listen({ host: '127.0.0.1', port });
console.log(
  `Airline demo: http://127.0.0.1:${port} | model=${service.model.name} (${service.model.mode}) | ${frozen ? 'frozen UTC clock' : 'live UTC clock'}`,
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void service.app.close().then(() => process.exit(0));
  });
