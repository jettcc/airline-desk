"""Exercise a delivered archive in a clean, spaced path. Real chat is opt-in.

Creates only temporary sample accounts. Never prints the packaged provider key.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def check(archive, output, real):
    output.mkdir(parents=True, exist_ok=True)
    parent = Path(tempfile.mkdtemp(prefix='airline launch handoff ')).resolve()
    stage = parent / 'airline-desk'
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            assert (parent / item.filename).resolve().is_relative_to(parent)
        z.extractall(parent)
        for item in z.infolist():
            mode = (item.external_attr >> 16) & 0o777
            if mode: (parent / item.filename).chmod(mode)
    assert not (stage / 'node_modules').exists() and not (stage / '.venv').exists()
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('AIRLINE_') or key == 'PORT': del env[key]
    (output / 'stage-path.txt').write_text(str(stage))
    report = {'status': 'RUNNING', 'initial_archive_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'checks': []}
    child = None

    def start(name, classic=False):
        log = (output / (name + '.log')).open('w')
        proc = subprocess.Popen(['bash', str(stage / 'start.sh'), '--no-browser', *(['--classic'] if classic else [])],
                                cwd=parent, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        log.close()
        until = time.monotonic() + 600
        status_file = stage / '.runtime/launcher-status.json'
        while time.monotonic() < until:
            if proc.poll() is not None:
                raise AssertionError(f'{name} failed; inspect {name}.log')
            if status_file.exists():
                state = json.loads(status_file.read_text())
                return proc, state
            time.sleep(.25)
        os.killpg(proc.pid, signal.SIGINT); proc.wait(timeout=20)
        raise AssertionError('Launcher timed out')

    def stop(proc, url):
        os.killpg(proc.pid, signal.SIGINT)
        proc.wait(timeout=20)
        assert not (stage / '.runtime/launcher-status.json').exists()
        try:
            urllib.request.urlopen(url, timeout=1)
        except OSError:
            return
        raise AssertionError('Child server survived launcher shutdown')

    def client(url):
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        csrf = ['']
        def request(path, payload=None):
            req = urllib.request.Request(url.rstrip('/') + '/api' + path,
                data=None if payload is None else json.dumps(payload).encode(),
                headers={} if payload is None else {'Content-Type': 'application/json', 'X-CSRF-Token': csrf[0]})
            with opener.open(req, timeout=30) as r: data = json.load(r)
            if path == '/bootstrap': csrf[0] = data['csrf']
            return data
        return request

    try:
        child, first = start('first-launch')
        api = client(first['url']); boot = api('/bootstrap')
        assert boot['service_trial'] is True and boot['model']['name'] == 'gpt-5.6-sol'
        assert (stage / '.runtime/installed-dependencies.sha256').exists()
        assert (stage / '.runtime/installed-python.sha256').exists()
        assert oct((stage / '.env.rightcodes.local').stat().st_mode & 0o777) == '0o600'
        report['checks'].append({'name': 'clean-install-in-path-with-spaces', 'status': 'PASS', 'node_version': first['node_version'], 'port': first['url']})
        second = subprocess.run(['bash', str(stage / 'start.sh'), '--no-browser'], cwd=parent, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=10)
        assert second.returncode != 0 and '已有启动程序运行' in second.stdout
        report['checks'].append({'name': 'duplicate-launch-refused', 'status': 'PASS'})
        api('/auth/register', {'username': 'handoff_test', 'password': 'Handoff-test-only-42'})
        registered = api('/bootstrap')['actor']['id']
        assert api('/tickets') == []
        if real:
            conversation = api('/conversations', {})['id']
            turn = api('/conversations/' + conversation + '/turns', {'message_key': 'handoff-real-baggage',
                'message': 'Bluehaven Basic，一件15kg、三边合计140cm的托运行李，要多少钱？'})
            until = time.monotonic() + 170
            while time.monotonic() < until:
                result = api('/turns/' + turn['id'])
                if result['state'] not in ['QUEUED', 'RUNNING']: break
                time.sleep(.4)
            assert result['state'] == 'COMPLETED', result.get('error')
            baggage = next(c['data'] for c in result['response']['cards'] if c['kind'] == 'baggage')
            # User-visible trusted baggage evaluation, no funds or operations.
            assert baggage['status'] == 'ALLOWED'
            assert baggage['evaluated_bag_count'] == 1
            assert baggage['extra_fee_per_person_per_segment'] == {'currencyCode': 'USD', 'units': '40', 'nanos': 0}
            assert baggage['sources']
            report['checks'].append({'name': 'bundled-key-real-baggage-chat', 'status': 'PASS', 'model': boot['model']['name'], 'fee_usd': '40.00', 'sources_verified': True})
        stop(child, first['url']); child = None
        install_stamp = (stage / '.runtime/installed-dependencies.sha256').stat().st_mtime_ns
        child, again = start('restart')
        api = client(again['url']); api('/bootstrap')
        api('/auth/login', {'username': 'handoff_test', 'password': 'Handoff-test-only-42'})
        assert api('/bootstrap')['actor']['id'] == registered
        assert install_stamp == (stage / '.runtime/installed-dependencies.sha256').stat().st_mtime_ns
        report['checks'].append({'name': 'restart-preserves-account-and-reuses-dependencies', 'status': 'PASS'})
        stop(child, again['url']); child = None
        config = stage / '.env.rightcodes.local'
        config.rename(parent / 'authorized-test-key.env')
        child, classic = start('classic-no-key', classic=True)
        api = client(classic['url']); boot = api('/bootstrap')
        assert boot['service_trial'] is False and boot['model']['mode'] == 'unconfigured'
        api('/auth/login', {'username': 'handoff_test', 'password': 'Handoff-test-only-42'})
        assert api('/bootstrap')['actor']['id'] == registered
        report['checks'].append({'name': 'classic-mode-without-key-still-preserves-data', 'status': 'PASS'})
        stop(child, classic['url']); child = None
        (parent / 'authorized-test-key.env').rename(config)
        report['checks'].append({'name': 'shutdown-stops-only-owned-server', 'status': 'PASS'})
        report['status'] = 'PASS'
    except BaseException:
        report['status'] = 'FAIL'
        raise
    finally:
        if child and child.poll() is None:
            os.killpg(child.pid, signal.SIGINT)
            child.wait(timeout=20)
        (output / 'launcher-check.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'evals/launch-handoff')
    parser.add_argument('--real', action='store_true', help='Explicitly use bundled approved key for one real chat')
    args = parser.parse_args()
    check(args.archive.resolve(), args.output.resolve(), args.real)
