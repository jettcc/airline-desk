#!/bin/bash
# macOS: double-click. Linux/macOS terminal: bash Start.command
cd -- "$(dirname -- "$0")" || exit 1
for candidate in python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert sys.version_info >= (3,10)' >/dev/null 2>&1; then
    "$candidate" scripts/start_demo.py "$@"
    result=$?
    if [ "$result" -ne 0 ] && [ -t 0 ]; then
      read -r -p '启动未完成，请查看上面的提示。按回车退出…' _airline_exit
    fi
    exit "$result"
  fi
done
echo '需要 Python 3.10 或以上版本。安装后重新双击 Start.command。'
if [ -t 0 ]; then read -r -p '按回车退出…' _airline_exit; fi
exit 1
