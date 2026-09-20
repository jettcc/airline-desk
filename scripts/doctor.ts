import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/db.js';
import { PolicyRegistry } from '../src/server/policies.js';
const checks: Array<{ check: string; status: string; detail: string }> = [];
checks.push({
  check: 'Node.js',
  status: process.versions.node.split('.')[0] === '24' ? 'PASS' : 'FAIL',
  detail: `Required 24.x; found ${process.versions.node}`,
});
let store: Store | undefined;
try {
  store = new Store(':memory:');
  const registry = new PolicyRegistry(store, process.cwd());
  checks.push({
    check: 'SQLite and policy bundle',
    status: 'PASS',
    detail: `${registry.bundles.size} verified bundle(s); no user database opened`,
  });
} catch {
  checks.push({
    check: 'SQLite and policy bundle',
    status: 'FAIL',
    detail: 'Run npm ci under Node 24; check supplied policy files and fingerprints',
  });
} finally {
  store?.close();
}
try {
  const python = existsSync('.venv/bin/python') ? '.venv/bin/python' : '/usr/bin/python3';
  execFileSync(
    python,
    [
      '-c',
      "import sys,sqlite3,pdfplumber; assert sys.version_info >= (3,10); db=sqlite3.connect(':memory:'); db.execute('CREATE VIRTUAL TABLE checks USING fts5(text)')",
    ],
    { stdio: 'pipe', timeout: 10000 },
  );
  checks.push({
    check: 'Python and FTS5',
    status: 'PASS',
    detail: 'Python >=3.10, PDF dependency and FTS5 available',
  });
} catch {
  checks.push({
    check: 'Python and FTS5',
    status: 'FAIL',
    detail: 'Create .venv and install requirements.txt with Python >=3.10 and SQLite FTS5',
  });
}
checks.push({
  check: 'Web build',
  status: existsSync('dist/web/index.html') ? 'PASS' : 'WARN',
  detail: 'Run npm run build before serving the web page',
});
const key = process.env.AIRLINE_MODEL_API_KEY,
  base = process.env.AIRLINE_MODEL_BASE_URL;
const configured = !!key && !!base;
checks.push({
  check: 'Model configuration',
  status: configured ? 'PASS' : 'WARN',
  detail: configured
    ? 'Credentials present; connectivity and billing were NOT probed'
    : 'No complete model configuration. Local tests work; natural-language chat needs your own key',
});
const report = {
  checks,
  status: checks.some((x) => x.status === 'FAIL') ? 'FAIL' : 'PASS',
  paid_requests: 0,
};
console.log(JSON.stringify(report, null, 2));
if (report.status === 'FAIL') process.exitCode = 1;
