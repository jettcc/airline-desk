"""Package plans, tested source, evidence, report and sanitized project conversation.

This is the complete handoff recipe; package_delivery.py preserves the earlier
selected-evidence archive recipe. Raw Codex logs and runtime user data stay out.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'deliverables'
OUT.mkdir(exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, default=OUT / 'airline-desk-complete-20260920.zip')
parser.add_argument('--include-demo-key', action='store_true', help='Explicit opt-in: include only the authorized model configuration for private interviewer handoff')
args = parser.parse_args()
archive_path = args.output.resolve()
assert archive_path.parent == OUT, 'Archive must be in deliverables/'
paths = set()


def add(path):
    assert not path.is_symlink(), path.name
    relative = path.resolve().relative_to(ROOT).as_posix()
    assert not relative.startswith(('var/', 'node_modules/', '.venv/', '.codex/', 'tmp/'))
    assert relative == '.env.example' or (args.include_demo_key and relative == '.env.rightcodes.local') or not path.name.startswith('.env')
    assert path.is_file(), relative
    paths.add(path.resolve())


for name in ['src', 'web', 'scripts', 'tests', 'tests-ts', 'tests-browser', 'skills', 'data', 'airline-policies', 'docs']:
    for p in (ROOT / name).rglob('*'):
        if p.is_file() and not p.is_symlink() and not any(x.startswith('.') or x == '__pycache__' for x in p.relative_to(ROOT).parts):
            add(p)
for name in ['READ_FIRST.md', 'README.md', 'Start.command', 'start.sh', 'package.json', 'package-lock.json', 'requirements.txt', 'requirements-dev.txt',
             'tsconfig.json', 'vite.config.ts', 'playwright.config.ts', '.env.example', '.nvmrc',
             '.prettierrc.json', '.prettierignore', '.gitignore', 'assignment-airline-2026-09-15.pdf',
             'output/pdf/airline-delivery-report.pdf']:
    add(ROOT / name)
if args.include_demo_key:
    add(ROOT / '.env.rightcodes.local')

session = ROOT / 'session'
for name in ['README.md', 'transcript.md', 'transcript.html', 'messages.jsonl', 'export-manifest.json']:
    add(session / name)
export = json.loads((session / 'export-manifest.json').read_text())
messages = [json.loads(line) for line in (session / 'messages.jsonl').read_text().splitlines()]
assert len(messages) == export['messages']
assert all(m['role'] in ('user', 'assistant') and m['phase'] in ('user', 'commentary', 'final_answer') for m in messages)
for item in export['attachments']:
    assert re.fullmatch(r'attachments/user-image-\d+\.(png|jpg)', item['path'])
    p = session / item['path']
    assert hashlib.sha256(p.read_bytes()).hexdigest() == item['sha256']
    add(p)

# Preserve selected current evidence and existing evidence linked by archived plans.
selection = ROOT / 'evals/optimization/delivery-evidence.json'
add(selection)
for item in json.loads(selection.read_text())['files']:
    p = ROOT / item
    assert p.resolve().is_relative_to(ROOT / 'evals')
    add(p)
for p in (ROOT / 'evals/handoff').glob('*'):
    if p.suffix in ('.json', '.log', '.md'):
        add(p)
for p in (ROOT / 'evals/launch-handoff').glob('*'):
    if p.suffix in ('.json', '.log', '.md'):
        add(p)
pending = [p for p in paths if p.suffix == '.md' and p.parent != session]
visited = set()
while pending:
    p = pending.pop()
    if p in visited:
        continue
    visited.add(p)
    for link in re.findall(r'\]\(([^)]+)\)', p.read_text()):
        if '://' in link or link.startswith('#'):
            continue
        target = (p.parent / link.split('#')[0].split(':')[0].strip('<>')).resolve()
        if not target.is_relative_to(ROOT):
            continue
        rel = target.relative_to(ROOT).as_posix()
        if target.is_file() and rel.startswith(('docs/', 'evals/')):
            assert target.suffix in ('.md', '.json', '.png', '.log', '.tap', '.txt', '.pdf')
            if target not in paths:
                add(target)
                if target.suffix == '.md':
                    pending.append(target)

manifest = []
temporary = archive_path.with_suffix('.zip.tmp')
try:
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
        for p in sorted(paths):
            relative = p.relative_to(ROOT).as_posix()
            blob = p.read_bytes()
            if relative == '.env.rightcodes.local':
                # Export only the approved provider fields, never unrelated local environment settings.
                allowed = {'AIRLINE_MODEL_PROVIDER', 'AIRLINE_MODEL_BASE_URL', 'AIRLINE_MODEL', 'AIRLINE_MODEL_API_KEY', 'AIRLINE_MODEL_BUDGET_USD'}
                values = {}
                for line in blob.decode().splitlines():
                    if '=' in line and not line.lstrip().startswith('#'):
                        k, value = line.split('=', 1)
                        if k in allowed: values[k] = value.strip()
                assert values.get('AIRLINE_MODEL') == 'gpt-5.6-sol'
                assert values.get('AIRLINE_MODEL_PROVIDER') == 'rightcodes'
                assert values.get('AIRLINE_MODEL_BASE_URL') == 'https://www.rightapi.ai/codex/v1'
                assert re.fullmatch(r'sk-[A-Za-z0-9_-]{12,}', values.get('AIRLINE_MODEL_API_KEY', ''))
                blob = ('# User-authorized, capped demo key. Private interviewer package. Do not publish.\n' +
                        '\n'.join(k + '=' + values[k] for k in sorted(values)) + '\n').encode()
            elif p.suffix in {'.ts', '.tsx', '.py', '.md', '.json', '.jsonl', '.html', '.log', '.tap', '.txt', '.example', '.sh', '.command'}:
                assert not re.search(rb'\bsk-[A-Za-z0-9_-]{20,}', blob), f'Credential-like value: {relative}'
            if p.suffix == '.sqlite':
                assert relative.startswith('data/knowledge/releases/') and p.name == 'index.sqlite'
            entry = zipfile.ZipInfo.from_file(p, arcname='airline-desk/' + relative)
            mode = 0o600 if relative == '.env.rightcodes.local' else 0o755 if relative in ('Start.command', 'start.sh') else 0o644
            entry.external_attr = (stat.S_IFREG | mode) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, blob)
            manifest.append({'path': relative, 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
        archive.writestr('airline-desk/DELIVERY_FILES.json', json.dumps(manifest, indent=2))
    temporary.replace(archive_path)
    if args.include_demo_key: archive_path.chmod(0o600)
finally:
    temporary.unlink(missing_ok=True)
digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
archive_path.with_suffix('.zip.sha256').write_text(digest + '  ' + archive_path.name + '\n')
print(json.dumps({'archive': str(archive_path), 'files': len(manifest), 'bytes': archive_path.stat().st_size,
                  'sha256': digest, 'session_messages': len(messages), 'authorized_demo_key_included': args.include_demo_key}))
