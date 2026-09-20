import type Database from 'better-sqlite3';

export function traceComplete(turns: any[], traces: any[]) {
  return (
    turns.length > 0 &&
    turns.every((t) => {
      const events = traces.filter((e) => e.turn_id === t.id);
      if (events[0]?.event !== 'turn_started' || events.at(-1)?.event !== 'turn_finished')
        return false;
      if (events.some((e, i) => e.sequence !== i + 1)) return false;
      if (events.at(-1).state !== t.state) return false;
      return events
        .filter((e) => e.event === 'tool_started')
        .every((e) =>
          events.some(
            (r) => r.call_id === e.call_id && ['tool_result', 'tool_error'].includes(r.event),
          ),
        );
    })
  );
}
export function exportConversation(db: Database.Database, conversationId: string) {
  if (!db.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId))
    throw new Error('Conversation not found');
  const traces = (
    db
      .prepare(
        'SELECT id,turn_id,created_at_ms,data FROM traces WHERE conversation_id=? ORDER BY rowid',
      )
      .all(conversationId) as any[]
  ).map(({ data, ...row }) => ({ ...row, ...JSON.parse(data) }));
  const turns = db
    .prepare('SELECT id,state,created_at_ms FROM turns WHERE conversation_id=? ORDER BY rowid')
    .all(conversationId) as any[];
  const quotes = (
    db
      .prepare('SELECT id,status,data FROM quotes WHERE conversation_id=? ORDER BY rowid')
      .all(conversationId) as any[]
  ).map((row) => {
    const q = JSON.parse(row.data);
    return {
      id: row.id,
      status: row.status,
      request: q.request,
      decision: q.decision,
      bundle_id: q.bundle_id,
      created_at_ms: q.created_at_ms,
      expires_at_ms: q.expires_at_ms,
    };
  });
  const submissions = db
    .prepare(
      'SELECT s.id,s.quote_id,s.received_at_ms,s.state,s.operation_id,s.error_code FROM submissions s JOIN quotes q ON q.id=s.quote_id WHERE q.conversation_id=? ORDER BY s.rowid',
    )
    .all(conversationId);
  const operations = (
    db
      .prepare(
        'SELECT o.data FROM operations o JOIN quotes q ON q.id=o.quote_id WHERE q.conversation_id=? ORDER BY o.rowid',
      )
      .all(conversationId) as any[]
  ).map((r) => {
    const o = JSON.parse(r.data);
    return {
      id: o.id,
      quote_id: o.quote_id,
      action: o.action,
      received_at_ms: o.received_at_ms,
      created_at_ms: o.created_at_ms,
      bundle_id: o.bundle_id,
      before_versions: o.before_versions,
      after_versions: Object.fromEntries(o.tickets.map((t: any) => [t.id, t.version])),
      lines: o.lines,
      totals: o.totals,
      sources: o.sources,
      simulated: true,
    };
  });
  const reviews = (db.prepare('SELECT data FROM review_cases').all() as any[])
    .map((r) => JSON.parse(r.data))
    .filter((r) => r.conversation_id === conversationId)
    .map((r) => ({
      id: r.id,
      status: r.status,
      type: r.type,
      amount: r.amount,
      decision: r.decision,
      bundle_id: r.bundle_id,
      turn_id: r.turn_id,
      ticket_versions: r.ticket_versions,
      previous_case_id: r.previous_case_id,
    }));
  return {
    scope: 'FICTIONAL_DEMO_DIAGNOSTICS',
    conversation_id: conversationId,
    status: traceComplete(turns, traces) ? 'COMPLETE' : 'INCOMPLETE',
    turns,
    traces,
    quotes,
    submissions,
    operations,
    reviews,
  };
}
