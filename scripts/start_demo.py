"""Local one-click launcher; installs project dependencies, never resets user data.

Python >=3.10 and npm are prerequisites. If needed, a pinned Node 24 runtime is
downloaded into npm's cache; no system/global package is replaced. No paid probe.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
NODE_PACKAGE = 'node@24.21.0'


def say(message):
    print(message, flush=True)


def version24(node):
    try:
        return subprocess.check_output([str(node), '--version'], text=True,
                                       stderr=subprocess.DEVNULL, timeout=10).strip().startswith('v24.')
    except (OSError, subprocess.SubprocessError):
        return False


def node_environment():
    env = dict(os.environ)
    # Finder often has a minimal PATH. Only discover existing standard install locations.
    extras = ['/opt/homebrew/bin', '/usr/local/bin', str(Path.home() / '.volta/bin')]
    extras += [str(p) for p in sorted((Path.home() / '.nvm/versions/node').glob('v24.*/bin'), reverse=True)]
    extras += ['/opt/homebrew/opt/node@24/bin', '/usr/local/opt/node@24/bin']
    env['PATH'] = os.pathsep.join([env.get('PATH', ''), *extras])
    npm = shutil.which('npm', path=env['PATH'])
    if not npm:
        raise RuntimeError('未找到 npm。请先安装带 npm 的 Node.js 24，再重新启动。')
    candidates = [shutil.which('node', path=env['PATH'])]
    candidates += [str(Path(p) / 'node') for p in extras]
    node = next((p for p in candidates if p and version24(p)), None)
    if node is None:
        say('正在准备 Node.js 24（仅下载到 npm 缓存，不替换系统版本）…')
        result = subprocess.run([npm, 'exec', '--yes', '--package=' + NODE_PACKAGE, '--',
                                 'node', '-p', 'process.execPath'], cwd=ROOT, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
        candidate = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ''
        if result.returncode or not Path(candidate).is_absolute() or not version24(candidate):
            raise RuntimeError('Node.js 24 下载失败。请检查 npm 网络，或安装 Node.js 24 后重试。')
        node = candidate
    env['PATH'] = str(Path(node).parent) + os.pathsep + env['PATH']
    return str(node), npm, env


def run(command, env):
    subprocess.run([str(x) for x in command], cwd=ROOT, env=env, check=True)


def free_port(requested=None):
    if requested is not None:
        try:
            value = int(requested)
        except (TypeError, ValueError):
            raise RuntimeError('PORT 必须是 1024–65535 的整数。') from None
        if not 1024 <= value <= 65535:
            raise RuntimeError('PORT 必须是 1024–65535 的整数。')
        ports = [value]
    else:
        ports = range(3000, 3011)
    for port in ports:
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', port))
            except OSError:
                continue
            return port
    raise RuntimeError('指定端口已占用。' if requested is not None else '3000–3010 均被占用，请通过 PORT 指定空闲端口。')


def prepare(node, npm, env):
    runtime = ROOT / '.runtime'
    version = subprocess.check_output([node, '-p', 'process.versions.node+":"+process.versions.modules'], text=True).strip()
    digest = hashlib.sha256((ROOT / 'package-lock.json').read_bytes() + version.encode()).hexdigest()
    stamp = runtime / 'installed-dependencies.sha256'
    valid = stamp.exists() and stamp.read_text() == digest
    if valid:
        valid = subprocess.run([node, '-e', "const D=require('better-sqlite3');new D(':memory:').close();require('tsx')"],
                               cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not valid:
        say('首次准备项目依赖，耗时取决于网络…')
        run([npm, 'ci', '--no-audit', '--no-fund'], env)
        stamp.write_text(digest)
    python = ROOT / '.venv/bin/python'
    if not python.exists():
        say('正在创建项目 Python 环境…')
        run([sys.executable, '-m', 'venv', ROOT / '.venv'], env)
    requirements = hashlib.sha256((ROOT / 'requirements.txt').read_bytes()).hexdigest()
    pystamp = runtime / 'installed-python.sha256'
    python_ok = subprocess.run([str(python), '-c',
        "import sys,sqlite3,pdfplumber; assert sys.version_info>=(3,10); sqlite3.connect(':memory:').execute('CREATE VIRTUAL TABLE t USING fts5(x)')"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not python_ok or not pystamp.exists() or pystamp.read_text() != requirements:
        say('正在准备政策检索所需依赖…')
        run([python, '-m', 'pip', 'install', '-r', 'requirements.txt'], env)
        pystamp.write_text(requirements)
    # Build every launch so copied/edited source is never served with a stale UI.
    say('正在检查并构建网页…')
    run([npm, 'run', 'build'], env)
    run([node, '--env-file-if-exists=.env.rightcodes.local', '--import', 'tsx', 'scripts/doctor.ts'], env)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Airline Desk 本地一键启动')
    parser.add_argument('--classic', action='store_true', help='只启动原作业模式，关闭可选服务试用')
    parser.add_argument('--no-browser', action='store_true', help='启动后不打开默认浏览器')
    args = parser.parse_args(argv)
    if sys.version_info < (3, 10) or sys.platform not in ('darwin', 'linux'):
        raise RuntimeError('此启动脚本支持 macOS/Linux，需要 Python 3.10+。')
    runtime = ROOT / '.runtime'
    runtime.mkdir(mode=0o700, exist_ok=True)
    with (runtime / 'launcher.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('此目录已有启动程序运行，请使用原来的终端和网页。') from None
        # Do not execute/source this file in a shell or print its contents.
        config = ROOT / '.env.rightcodes.local'
        if config.exists():
            config.chmod(0o600)
        say('Airline Desk：启动本地演示；不会清空已有账号或客票。')
        node, npm, env = node_environment()
        prepare(node, npm, env)
        port = free_port(env.get('PORT'))
        env['PORT'] = str(port)
        env.setdefault('AIRLINE_DB', str(ROOT / 'var/interview.sqlite'))
        env['AIRLINE_SERVICE_TRIAL'] = '0' if args.classic else env.get('AIRLINE_SERVICE_TRIAL', '1')
        if env['AIRLINE_SERVICE_TRIAL'] not in ('0', '1'):
            raise RuntimeError('AIRLINE_SERVICE_TRIAL 必须为 0 或 1。')
        url = f'http://127.0.0.1:{port}/'
        say('正在启动；保持此窗口打开，按 Ctrl+C 停止。')
        child = subprocess.Popen([node, '--env-file-if-exists=.env.rightcodes.local', '--import', 'tsx', 'src/server/main.ts'],
                                 cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, start_new_session=True)
        opened = False
        try:
            for line in child.stdout:
                print(line, end='', flush=True)
                if not opened and line.startswith('Airline demo:'):
                    opened = True
                    say('已就绪：' + url)
                    (runtime / 'launcher-status.json').write_text(json.dumps({'pid': child.pid, 'url': url,
                        'service_trial': env['AIRLINE_SERVICE_TRIAL'] == '1', 'node_version': subprocess.check_output([node, '--version'], text=True).strip()}))
                    if not args.no_browser:
                        webbrowser.open(url)
            code = child.wait()
            if code:
                raise RuntimeError('服务未能启动或已异常退出，请按上面的错误提示处理。')
        except KeyboardInterrupt:
            say('\n正在停止本次启动的服务，业务数据会保留。')
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
            (runtime / 'launcher-status.json').unlink(missing_ok=True)


if __name__ == '__main__':
    def stop_launcher(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_launcher)
    signal.signal(signal.SIGHUP, stop_launcher)
    try:
        main()
    except KeyboardInterrupt:
        say('\n启动已取消；再次运行可继续准备，已有业务数据不受影响。')
        sys.exit(130)
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        # Never dump the environment or credential configuration on failure.
        say('启动未完成：' + str(error))
        sys.exit(1)
