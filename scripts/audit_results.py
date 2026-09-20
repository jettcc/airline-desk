"""Independently audit persisted fictional acceptance money and state, never model prose."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(sys.argv[1])
summary = json.loads((root / 'summary.json').read_text())
assert summary['scope'] == 'full-A01-A10'
assert {c['id'] for c in summary['cases']} == {f'A{i:02}' for i in range(1, 11)}
assert summary['status'] == 'PASS'

def nanos(m):
    assert m['currencyCode'] == 'USD'
    return int(m['units']) * 1_000_000_000 + m['nanos']

records = []
for i in range(1, 11):
    case = json.loads((root / f'A{i:02}.json').read_text())
    db = case['persisted']
    assert case['status'] == 'PASS' and case['trace_status'] == 'COMPLETE'
    expected_ops = {1: 0, 2: 0, 3: 1, 4: 0, 5: 1, 6: 1, 7: 1, 8: 0, 9: 3, 10: 1}[i]
    assert len(db['operations']) == expected_ops
    assert len({o['quote_id'] for o in db['operations']}) == expected_ops
    for op in db['operations']:
        ledger = [l for l in db['ledger'] if l['operation_id'] == op['id']]
        for field, direction in [('collect', 'COLLECT'), ('refund', 'REFUND'), ('credit', 'CREDIT'), ('forfeit', 'FORFEIT')]:
            actual = sum(int(l['units']) * 1_000_000_000 + l['nanos'] for l in ledger if l['direction'] == direction)
            assert actual == nanos(op['totals'][field]), (case['id'], field)
        assert all(nanos(l['amount']) >= 0 for l in op['lines'])
        credit = sum(int(c['units']) * 1_000_000_000 + c['nanos'] for c in db['credits'] if c['operation_id'] == op['id'])
        assert credit == nanos(op['totals']['credit'])
    if i == 3:
        assert nanos(db['operations'][0]['totals']['collect']) == 220_000_000_000
        assert [t['version'] for t in db['tickets'] if t['id'] in ['NSA-A', 'NSA-B']] == [2, 2]
    if i == 5:
        assert nanos(db['operations'][0]['totals']['collect']) == 85_000_000_000
    if i in [6, 10]:
        op = db['operations'][0]
        assert [nanos(op['totals'][k]) for k in ['collect', 'refund', 'credit', 'forfeit']] == [0, 20_000_000_000, 60_000_000_000, 50_000_000_000]
        assert len(db['credits']) == 1
        c = db['credits'][0]
        assert c['traveler_id'] == 'traveler-alice' and c['airline'] == 'NSA'
        assert c['expires_at_ms'] - c['issued_at_ms'] == 365 * 86400000
    if i == 7:
        assert nanos(db['operations'][0]['totals']['refund']) == 280_000_000_000
        assert len([c for c in db['consumptions'] if c['kind'] == 'DISRUPTION_CHOICE']) == 1
    if i == 8:
        assert len(db['reviews']) == 1
        r = db['reviews'][0]
        assert r['amount'] == {'status': 'UNKNOWN', 'value': None}
        assert 'UNUSED_AFFECTED_PORTION_REFUND_RIGHT' in r['decision']['known_rights']
        assert r['conversation_id'] and r['turn_id'] and r['ticket_versions']
    records.append({'id': case['id'], 'status': 'PASS', 'operations': expected_ops,
                    'totals_reconciled_from_ledger': True, 'trace_complete': True})
report = {'status': 'PASS', 'checked_at_utc': datetime.now(timezone.utc).isoformat(),
          'scope': 'Independent Python integer and persisted-state assertions; no second-model or human review claimed',
          'cases': records}
(root / 'financial-audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'status': 'PASS', 'cases': len(records)}))
