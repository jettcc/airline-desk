import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { exportConversation } from '../src/server/trace.js';
const [filename, conversationId, output] = process.argv.slice(2);
if (!filename || !conversationId || !output)
  throw new Error(
    'Usage: export_trace.ts var/demo.sqlite conversation_ID output.json. Only export these fictional demo records.',
  );
const db = new Database(filename, { readonly: true });
try {
  const data = exportConversation(db, conversationId);
  const serialized = JSON.stringify(data, null, 2);
  if (
    /sk-[a-zA-Z0-9_-]{10,}|"(confirmation_token|csrf|token_hash|encrypted_content)"/.test(
      serialized,
    )
  )
    throw new Error('Secret field detected; export refused');
  writeFileSync(resolve(output), serialized + '\n');
  console.log(JSON.stringify({ status: data.status, events: data.traces.length, output }));
} finally {
  db.close();
}
