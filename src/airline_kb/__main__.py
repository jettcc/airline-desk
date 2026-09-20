import argparse
import json
import sqlite3
import sys
from pathlib import Path

from .query import KnowledgeBase
from .storage import KnowledgeError, activate, resolve_release


def main():
    parser = argparse.ArgumentParser(description="M1 airline policy evidence tools; no booking operations")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--store", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("build", help="Build and publish reviewed source files")
    commands.add_parser("verify", help="Verify the active snapshot and every stored artifact")
    rollback = commands.add_parser("activate", help="Explicitly select an existing verified evidence snapshot")
    rollback.add_argument("release_id")
    search = commands.add_parser("search", help="Return cited policy evidence, not a booking decision")
    search.add_argument("question")
    search.add_argument("--airline")
    search.add_argument("--compare", action="store_true")
    search.add_argument("--request-at")
    search.add_argument("--release")
    args = parser.parse_args()
    store = args.store or args.root / "data/knowledge"
    try:
        if args.command == "build":
            from .build import build
            result = build(args.root, store)
        elif args.command == "verify":
            _, result = resolve_release(store)
            result = {"status": "VERIFIED", **result}
        elif args.command == "activate":
            result = {"status": "ACTIVATED", **activate(store, args.release_id)}
        else:
            result = KnowledgeBase(store).search(args.question, args.airline, args.compare, args.request_at, args.release)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (KnowledgeError, OSError, ValueError, KeyError, sqlite3.Error, ImportError) as error:
        print(json.dumps({"status": getattr(error, "code", "UNAVAILABLE"), "message": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
