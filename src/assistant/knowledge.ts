import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PolicyRegistry } from '../server/policies.js';
import type { Airline } from '../domain/types.js';
import { ensure } from '../server/errors.js';
import { policySummary } from './policy-summary.js';
const execute = promisify(execFile);
export class KnowledgeAdapter {
  private executable: string;
  constructor(
    private root: string,
    private policies: PolicyRegistry,
    private runQuery: typeof execute = execute,
  ) {
    this.executable = existsSync(join(root, '.venv/bin/python'))
      ? join(root, '.venv/bin/python')
      : '/usr/bin/python3';
  }
  async search(question: string, airline: Airline | null, compare: boolean, at: number) {
    ensure(question.length > 0 && question.length <= 2000, 'INVALID_QUESTION');
    const scope: Airline[] = airline ? [airline] : ['NSA', 'BHA', 'STA'];
    const assignments = scope.map((airline) => ({
      airline,
      bundle: this.policies.select(airline, at),
    }));
    const bundles = assignments.map((a) => a.bundle);
    // Different evidence releases are searched independently, never merged as if one version.
    const releases = [...new Set(bundles.map((b) => b.release_id))];
    const parts = [];
    for (const release of releases) {
      const args = [
        '-m',
        'airline_kb',
        '--root',
        this.root,
        'search',
        question,
        '--request-at',
        new Date(at).toISOString(),
        '--release',
        release,
      ];
      if (airline) args.push('--airline', airline);
      if (compare) args.push('--compare');
      const { stdout } = await this.runQuery(this.executable, args, {
        cwd: this.root,
        shell: false,
        timeout: 10000,
        maxBuffer: 500000,
        env: {
          PATH: '/usr/bin:/bin',
          PYTHONPATH: join(this.root, 'src'),
          PYTHONIOENCODING: 'utf-8',
          PYTHONDONTWRITEBYTECODE: '1',
        },
      });
      const raw = JSON.parse(stdout);
      ensure(
        raw.release_id === release && Array.isArray(raw.evidence),
        'INVALID_POLICY_RESULT',
        503,
      );
      const assigned = assignments.filter((a) => a.bundle.release_id === release);
      const evidence = raw.evidence.filter((c: any) =>
        assigned.some((a) => a.airline === c.airline),
      );
      parts.push({
        status: raw.status,
        release_id: raw.release_id,
        topics: raw.topics,
        uncovered_topics: raw.uncovered_topics ?? [],
        summaries:
          raw.status === 'FOUND'
            ? assigned
                .filter((a) => evidence.some((c: any) => c.airline === a.airline))
                .map((a) => ({
                  airline: a.airline,
                  bundle_id: a.bundle.id,
                  ...policySummary(a.airline, raw.topics, a.bundle.rules),
                }))
            : [],
        evidence: evidence.map((c: any) => ({
          id: c.id,
          airline: c.airline,
          section: c.section,
          title: c.title,
          text: c.text,
          tables: c.tables,
          pages: c.pages,
          version: c.version,
          url: `/api/policies/${release}/${c.airline}.pdf#page=${c.pages[0]}`,
        })),
      });
    }
    return { parts };
  }
}
