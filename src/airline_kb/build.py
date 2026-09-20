"""Import only reviewed policy PDFs. Unreviewed changes fail closed."""

import io
import json
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path

from .storage import (KnowledgeError, digest, json_bytes, publish_lock,
                      replace_pointer, sync_directory, verify_release, write_bytes, write_json)

SCHEMA = 1
HEADING = re.compile(r"^(?:(\d+\.\d+|\d+\.) ([A-Z].*)|Appendix ([A-Z])\. (.*))$")


def normalize_tables(tables):
    return [[[" ".join((cell or "").split()) for cell in row] for row in table] for table in tables]


def extract_document(root, spec, reviewed):
    import pdfplumber
    source = root / spec["path"]
    raw = source.read_bytes()
    if digest(raw) != spec["reviewed_sha256"]:
        raise KnowledgeError("REVIEW_REQUIRED", f"Unreviewed source change: {spec['path']}")
    pages, chunks = [], []
    current = None
    seen = set()
    # Parse the exact bytes whose fingerprint was checked, even if the input is replaced concurrently.
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        if len(pdf.pages) != spec["page_count"]:
            raise KnowledgeError("REVIEW_REQUIRED", "Unexpected page count")
        for number, page in enumerate(pdf.pages, 1):
            text = page.extract_text() or ""
            tables = normalize_tables(page.extract_tables())
            if tables != reviewed[spec["airline"]][str(number)]:
                raise KnowledgeError("REVIEW_REQUIRED", f"Table extraction differs: {spec['airline']} page {number}")
            if not text.strip():
                raise KnowledgeError("REVIEW_REQUIRED", "Empty page or unsupported scanned PDF")
            pages.append({"page": number, "text": text, "tables": tables})
            for line in text.splitlines():
                if re.fullmatch(r".*\| v[\d.]+ \| Passenger Policies \d+ / \d+", line):
                    continue
                match = HEADING.match(line)
                if match or current is None:
                    if match:
                        section = match[1].rstrip(".") if match[1] else "Appendix " + match[3]
                    else:
                        section = "document"
                    if section in seen:
                        raise KnowledgeError("REVIEW_REQUIRED", f"Duplicate section: {section}")
                    seen.add(section)
                    current = {"id": f"{spec['airline']}:{section}", "airline": spec["airline"],
                               "section": section, "title": line if match else "Document metadata",
                               "version": spec["version"], "effective_from": spec["effective_from"],
                               "source_sha256": spec["reviewed_sha256"],
                               "source_file": f"sources/{spec['airline']}.pdf", "pages": [], "lines": [], "tables": []}
                    chunks.append(current)
                current["lines"].append(line)
                if number not in current["pages"]:
                    current["pages"].append(number)
            if tables:
                section = spec["table_sections"][str(number)]
                target = next((c for c in chunks if c["section"] == section), None)
                if target is None or len(tables) != 1:
                    raise KnowledgeError("REVIEW_REQUIRED", "Unreviewed table-to-section mapping")
                target["tables"].append({"page": number, "rows": tables[0]})
    if seen != set(spec["sections"]):
        raise KnowledgeError("REVIEW_REQUIRED", f"Section inventory changed: {spec['airline']}")
    metadata = pages[0]["text"]
    for literal in [spec["name"] + " | " + spec["airline"], "Document version " + spec["version"],
                    "Effective " + spec["effective_from"][:10] + " at 00:00:00 UTC"]:
        if literal not in metadata:
            raise KnowledgeError("REVIEW_REQUIRED", "Source metadata mismatch")
    for chunk in chunks:
        chunk["text"] = "\n".join(chunk.pop("lines"))
    document = {**spec, "snapshot_file": f"sources/{spec['airline']}.pdf", "pages": pages}
    return document, chunks, raw


def build(root, output=None):
    root = Path(root).resolve()
    output = Path(output).resolve() if output else root / "data/knowledge"
    inputs = root / "data/policy-inputs"
    with publish_lock(output):
        input_raw = {name: (inputs / name).read_bytes() for name in
                     ["catalog.json", "reviewed-tables.json", "retrieval.json"]}
        catalog = json.loads(input_raw["catalog.json"])
        reviewed = json.loads(input_raw["reviewed-tables.json"])
        retrieval = json.loads(input_raw["retrieval.json"])
        specs = catalog["documents"]
        if {s["airline"] for s in specs} != {"NSA", "BHA", "STA"} or len(specs) != 3:
            raise KnowledgeError("REVIEW_REQUIRED", "This importer is reviewed for exactly the three supplied airlines")
        for spec in specs:
            source = (root / spec["path"]).resolve()
            if not source.is_relative_to((root / "airline-policies").resolve()):
                raise KnowledgeError("REVIEW_REQUIRED", "Source is outside the policy directory")
        documents, chunks, pdfs = [], [], {}
        for spec in specs:
            document, pieces, raw = extract_document(root, spec, reviewed)
            documents.append(document)
            chunks.extend(pieces)
            pdfs[document["snapshot_file"]] = raw
        for spec in specs:
            available = set(spec["sections"])
            for topic in retrieval["topics"].values():
                required = set(topic["sections"] + topic.get("airline_sections", {}).get(spec["airline"], []))
                if not required.issubset(available):
                    raise KnowledgeError("REVIEW_REQUIRED", "Retrieval refers to a missing section")
        staging = Path(tempfile.mkdtemp(prefix=".stage-", dir=output))
        try:
            write_json(staging / "documents.json", documents)
            write_json(staging / "chunks.json", chunks)
            write_json(staging / "retrieval.json", retrieval)
            for filename, raw in pdfs.items():
                write_bytes(staging / filename, raw)
            with sqlite3.connect(staging / "index.sqlite") as db:
                db.execute("CREATE TABLE chunks(id TEXT PRIMARY KEY, airline TEXT NOT NULL, section TEXT NOT NULL, payload TEXT NOT NULL)")
                db.execute("CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED, airline UNINDEXED, title, text, tokenize='unicode61')")
                for chunk in chunks:
                    db.execute("INSERT INTO chunks VALUES(?,?,?,?)", (chunk["id"], chunk["airline"], chunk["section"], json_bytes(chunk).decode()))
                    db.execute("INSERT INTO search VALUES(?,?,?,?)", (chunk["id"], chunk["airline"], chunk["title"], chunk["text"]))
                db.execute("INSERT INTO search(search) VALUES('integrity-check')")
            db.close()
            with (staging / "index.sqlite").open("rb") as handle:
                import os
                os.fsync(handle.fileno())
            files = {p.relative_to(staging).as_posix(): digest(p.read_bytes()) for p in sorted(staging.rglob("*")) if p.is_file()}
            manifest = {"schema": SCHEMA, "purpose": "evidence_only", "business_rules_package": None,
                        "files": files, "reviewed_sources": {s["airline"]: s["reviewed_sha256"] for s in specs},
                        "input_checksums": {name: digest(raw) for name, raw in sorted(input_raw.items())},
                        "counts": {"documents": len(documents), "pages": sum(len(d["pages"]) for d in documents),
                                   "chunks": len(chunks), "tables": sum(len(p["tables"]) for d in documents for p in d["pages"])}}
            release_id = digest(json_bytes(manifest))[:24]
            manifest["release_id"] = release_id
            write_json(staging / "manifest.json", manifest)
            verify_release(staging)
            releases = output / "releases"
            releases.mkdir(exist_ok=True)
            destination = releases / release_id
            reused = destination.exists()
            if reused:
                verify_release(destination)
            else:
                sync_directory(staging / "sources")
                sync_directory(staging)
                staging.rename(destination)
                sync_directory(releases)
            replace_pointer(output, release_id)
            return {"status": "PUBLISHED", "release_id": release_id, "reused": reused, **manifest["counts"], "purpose": "evidence_only"}
        finally:
            if staging.exists():
                shutil.rmtree(staging)
