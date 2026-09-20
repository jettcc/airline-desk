"""Conservative evidence retrieval; a match never authorizes a booking decision."""

import json
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from .storage import KnowledgeError, read_json, resolve_release


def utc(value):
    if value is None:
        return datetime.now(timezone.utc)
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("A timezone is required")
        return parsed.astimezone(timezone.utc)
    except (ValueError, AttributeError, TypeError) as error:
        raise KnowledgeError("INVALID_INPUT", "request_at must be an ISO timestamp with timezone") from error


def contains(text, term):
    if re.search(r"[\u3400-\u9fff]", term):
        return term in text
    return bool(re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", text))


class KnowledgeBase:
    def __init__(self, root):
        self.root = Path(root)

    def search(self, question, airline=None, compare=False, request_at=None, release_id=None):
        if not isinstance(question, str) or not question.strip() or len(question) > 4000:
            raise KnowledgeError("INVALID_INPUT", "Question must contain 1 to 4000 characters")
        when = utc(request_at)
        path, manifest = resolve_release(self.root, release_id)
        documents = read_json(path / "documents.json")
        config = read_json(path / "retrieval.json")
        lowered = question.casefold()
        mentioned = {doc["airline"] for doc in documents if any(contains(lowered, name) for name in doc["aliases"])}
        base = {"release_id": manifest["release_id"], "purpose": "policy_evidence_only",
                "booking_decision": "NOT_EVALUATED", "request_at": when.isoformat(),
                "evidence": [], "candidates": [], "topics": [], "required_booking_facts": [],
                "trace": {"source": "reviewed_local_pdfs", "method": "section_relations_plus_fts5"}}
        if compare and airline:
            return {**base, "status": "NEEDS_CONTEXT", "message": "Choose single-airline scope or explicit comparison, not both."}
        explicit = None
        if airline:
            if not isinstance(airline, str):
                raise KnowledgeError("INVALID_INPUT", "airline must be a name or code")
            explicit = next((d["airline"] for d in documents if airline.casefold() in d["aliases"]), None)
            if explicit is None:
                return {**base, "status": "NO_EVIDENCE", "message": "No reviewed document for this airline; no substitute airline was selected."}
        if explicit and mentioned - {explicit}:
            return {**base, "status": "NEEDS_CONTEXT", "message": "Question and explicit airline scope conflict; clarify the airline or use comparison."}
        scope = ({explicit} if explicit else mentioned) if not compare else (mentioned or {d["airline"] for d in documents})
        if not scope or (len(scope) > 1 and not compare):
            return {**base, "status": "NEEDS_CONTEXT", "message": "Specify one airline, or explicitly request a comparison.", "missing_context": ["airline_or_comparison"]}
        base["airlines"] = sorted(scope)
        unsupported = [d["airline"] for d in documents if d["airline"] in scope and when < utc(d["effective_from"])]
        if unsupported:
            return {**base, "status": "UNSUPPORTED_PERIOD", "message": "The supplied publications do not cover this request date.", "unsupported_airlines": unsupported}
        topics = [name for name, topic in config["topics"].items() if any(contains(lowered, alias) for alias in topic["aliases"])]
        excluded = [item for item in config["not_covered"] if any(contains(lowered, alias) for alias in item["aliases"])]
        base["topics"] = topics
        base["required_booking_facts"] = sorted({fact for name in topics for fact in config["topics"][name]["booking_facts"]})
        required_ids = set()
        for code in scope:
            sections = set()
            for name in topics:
                topic = config["topics"][name]
                sections.update(topic["sections"])
                sections.update(topic.get("airline_sections", {}).get(code, []))
            for item in excluded:
                sections.update(item["sections"])
            required_ids.update(f"{code}:{section}" for section in sections)
        terms = re.findall(r"[a-z0-9]+", lowered)
        stop = {"the", "a", "i", "my", "and", "or", "to", "is", "can", "do", "does", "how", "what", "for", "of", "on", "in", "me", "it", "with", "air", "airways", "nsa", "bha", "sta", "northstar", "bluehaven", "suntrail"}
        terms = list(dict.fromkeys(term for term in terms if term not in stop))[:24]
        fts_query = " OR ".join('"' + term + '"' for term in terms)
        query_scope = sorted(scope)
        placeholders = ",".join("?" for _ in query_scope)
        with closing(sqlite3.connect((path / "index.sqlite").resolve().as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            rows = db.execute(f"SELECT payload FROM chunks WHERE airline IN ({placeholders}) ORDER BY rowid", query_scope).fetchall()
            lexical_ids = []
            if fts_query:
                lexical_ids = [row[0] for row in db.execute(
                    f"SELECT id FROM search WHERE search MATCH ? AND airline IN ({placeholders}) ORDER BY rank LIMIT 8",
                    [fts_query, *query_scope])]
            indexed = [json.loads(row[0]) for row in rows]
        base["trace"]["lexical_candidate_ids"] = lexical_ids
        for chunk in indexed:
            chunk["citation"] = {"release_id": manifest["release_id"], "airline": chunk["airline"],
                                 "version": chunk["version"], "section": chunk["section"], "pages": chunk["pages"],
                                 "source_sha256": chunk["source_sha256"],
                                 "snapshot_pdf": str((path / chunk["source_file"]).resolve())}
            if chunk["id"] in required_ids:
                base["evidence"].append(chunk)
            elif chunk["id"] in lexical_ids:
                base["candidates"].append(chunk)
        returned_ids = {chunk["id"] for chunk in base["evidence"]}
        if required_ids - returned_ids:
            raise KnowledgeError("UNAVAILABLE", "Required policy evidence is missing from the index")
        if excluded:
            return {**base, "status": "NO_EVIDENCE", "uncovered_topics": [item["name"] for item in excluded],
                    "message": "The publication does not specify at least one requested topic. Attached scope statements are not permission or prohibition. Other matched topics may have evidence."}
        if not topics:
            return {**base, "status": "NO_EVIDENCE", "message": "No reviewed topic matched. Full-text candidates, if any, are not a verified complete answer; clarify the question."}
        return {**base, "status": "FOUND", "message": "Policy evidence located. Applicability to a specific booking, amounts, and authorization have not been evaluated."}
