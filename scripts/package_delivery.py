"""Build a reviewable local-source archive; never include credentials or user databases."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'deliverables'
OUT.mkdir(exist_ok=True)
paths = set()
roots = ['src', 'web', 'scripts', 'tests', 'tests-ts', 'tests-browser', 'skills', 'data', 'airline-policies']
for name in roots:
    for p in (ROOT / name).rglob('*'):
        if p.is_file() and not p.is_symlink() and not any(x.startswith('.') or x == '__pycache__' for x in p.relative_to(ROOT).parts):
            paths.add(p)
for name in ['README.md', 'package.json', 'package-lock.json', 'requirements.txt', 'requirements-dev.txt',
             'tsconfig.json', 'vite.config.ts', 'playwright.config.ts', '.env.example', '.nvmrc',
             '.prettierrc.json', '.prettierignore', '.gitignore', 'assignment-airline-2026-09-15.pdf']:
    paths.add(ROOT / name)
for name in ['SUBMISSION.md', 'DESIGN.md', 'DEMO.md', 'SETUP_REFERENCE.md', 'VALIDATION.md',
             'EXAMPLE_TRACE.md', 'BUSINESS_GAPS.md', 'FINAL_DELIVERY.md', 'SERVICE_TRIAL.md',
             'SERVICE_TRIAL_PLAN.md']:
    paths.add(ROOT / 'docs' / name)
# Current evidence is explicitly selected, never broad-copy a runtime/evidence tree.
selection = ROOT / 'evals/optimization/delivery-evidence.json'
if selection.exists():
    for item in json.loads(selection.read_text())['files']:
        p = ROOT / item
        if not p.resolve().is_relative_to(ROOT / 'evals') or p.is_symlink() or not p.is_file():
            raise ValueError('Invalid evidence path')
        paths.add(p)
manifest = []
with zipfile.ZipFile(OUT / 'airline-desk.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for p in sorted(paths):
        relative = p.relative_to(ROOT).as_posix()
        assert p.is_file() and not p.is_symlink(), relative
        assert not relative.startswith(('var/', 'node_modules/', '.venv/'))
        assert relative == '.env.example' or not p.name.startswith('.env')
        blob = p.read_bytes()
        # Text secret checks complement the allowlist; sample IDs and mock booking state are allowed.
        if p.suffix in {'.ts', '.tsx', '.py', '.md', '.json', '.log', '.tap', '.txt', '.example'}:
            import re
            assert not re.search(rb'\bsk-[A-Za-z0-9_-]{20,}', blob), relative
        archive.writestr('airline-desk/' + relative, blob)
        manifest.append({'path': relative, 'bytes': len(blob), 'sha256': hashlib.sha256(blob).hexdigest()})
    archive.writestr('airline-desk/DELIVERY_FILES.json', json.dumps(manifest, indent=2))
print(json.dumps({'archive': str(OUT / 'airline-desk.zip'), 'files': len(manifest),
                  'bytes': (OUT / 'airline-desk.zip').stat().st_size,
                  'sha256': hashlib.sha256((OUT / 'airline-desk.zip').read_bytes()).hexdigest()}))
