import { readFileSync } from 'node:fs';
import { Store } from '../src/server/db.js';
import { PolicyRegistry } from '../src/server/policies.js';
const mode = process.argv[2],
  file = process.argv[3];
if (!['verify', 'activate'].includes(mode) || !file)
  throw new Error(
    'Usage: policy.ts verify|activate data/rules/reviewed-bundle.json. Stop the service before activation.',
  );
const store = new Store(process.env.AIRLINE_DB ?? 'var/airline.sqlite', false);
try {
  const registry = new PolicyRegistry(store, process.cwd()),
    rules = JSON.parse(readFileSync(file, 'utf8')),
    bundle = mode === 'activate' ? registry.activate(rules) : registry.verify(rules);
  console.log(
    JSON.stringify({
      mode,
      bundle_id: bundle.id,
      release_id: bundle.release_id,
      rules_hash: bundle.rules_hash,
      code_hash: bundle.code_hash,
    }),
  );
} finally {
  store.close();
}
