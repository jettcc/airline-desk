import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../server/db.js';
import { ensure } from '../server/errors.js';
export const skillNames = [
  'policy-consultation',
  'booking-lookup',
  'change-quote',
  'cancel-refund',
  'disruption-options',
  'baggage-check',
  'review-and-recovery',
];
export class SkillRegistry {
  version: string;
  instructions: string;
  constructor(root: string) {
    const parts = skillNames.map((name) => {
      const text = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8');
      ensure(text.includes('Tool contract: 1'), 'SKILL_CONTRACT_MISMATCH');
      return text;
    });
    this.instructions = parts.join('\n\n');
    this.version = hash(this.instructions).slice(0, 24);
  }
}
