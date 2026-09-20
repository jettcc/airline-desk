"""Immutable local snapshots with an atomic, serialized publication pointer."""

import hashlib
import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path


class KnowledgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())


def write_json(path, value):
    write_bytes(path, json_bytes(value))


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def publish_lock(root):
    # Supported publication target: a local POSIX filesystem, not NFS or Windows.
    import fcntl
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".publish.lock").open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def verify_release(path):
    path = Path(path)
    try:
        manifest = read_json(path / "manifest.json")
        identity = {k: v for k, v in manifest.items() if k != "release_id"}
        if digest(json_bytes(identity))[:24] != manifest["release_id"]:
            raise ValueError("Manifest identity mismatch")
        required = {"documents.json", "chunks.json", "retrieval.json", "index.sqlite"}
        if not required.issubset(manifest["files"]):
            raise ValueError("Snapshot is missing required files")
        for filename, checksum in manifest["files"].items():
            target = path / filename
            if target.is_symlink() or not target.resolve().is_relative_to(path.resolve()):
                raise ValueError("Invalid snapshot path")
            if digest(target.read_bytes()) != checksum:
                raise ValueError(f"Snapshot checksum mismatch: {filename}")
        with sqlite3.connect((path / "index.sqlite").resolve().as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Index integrity check failed")
            count = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
            if count != manifest["counts"]["chunks"]:
                raise ValueError("Index count mismatch")
        return manifest
    except (OSError, ValueError, KeyError, sqlite3.Error) as error:
        raise KnowledgeError("UNAVAILABLE", f"Knowledge snapshot failed verification: {error}") from error


def resolve_release(root, release_id=None):
    root = Path(root).resolve()
    if release_id is None:
        try:
            release_id = (root / "CURRENT").read_text().strip()
        except OSError as error:
            raise KnowledgeError("UNAVAILABLE", "No published knowledge snapshot") from error
    if not isinstance(release_id, str) or not re.fullmatch(r"[0-9a-f]{24}", release_id):
        raise KnowledgeError("INVALID_INPUT", "Invalid knowledge release identifier")
    path = root / "releases" / release_id
    manifest = verify_release(path)
    if manifest["release_id"] != release_id:
        raise KnowledgeError("UNAVAILABLE", "Release directory does not match manifest")
    return path, manifest


def activate(root, release_id):
    """Explicitly activate an existing, verified evidence snapshot under the writer lock."""
    root = Path(root)
    with publish_lock(root):
        _, manifest = resolve_release(root, release_id)
        replace_pointer(root, release_id)
        return manifest


def replace_pointer(root, release_id):
    """Caller holds publish_lock; readers never see a partially written pointer."""
    temporary = root / (".current-" + uuid.uuid4().hex)
    try:
        write_bytes(temporary, (release_id + "\n").encode())
        os.replace(temporary, root / "CURRENT")
        sync_directory(root)
    finally:
        temporary.unlink(missing_ok=True)
