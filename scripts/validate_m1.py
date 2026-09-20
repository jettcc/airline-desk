"""Run M1 assertions and save actual, reproducible results; no model or booking claims."""

import hashlib
import json
import platform
import sqlite3
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from airline_kb import KnowledgeBase
from airline_kb.build import build
from airline_kb.storage import resolve_release, write_json


class RecordedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.records = []

    def startTest(self, test):
        self.started = time.perf_counter()
        super().startTest(test)

    def record(self, test, status, error=None):
        self.records.append({"case": test.id(), "status": status,
                             "seconds": round(time.perf_counter() - self.started, 4), "error": error})

    def addSuccess(self, test):
        super().addSuccess(test)
        self.record(test, "PASS")

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.record(test, "FAIL", self._exc_info_to_string(error, test))

    def addError(self, test, error):
        super().addError(test, error)
        self.record(test, "ERROR", self._exc_info_to_string(error, test))


def main():
    output = ROOT / "evals/m1"
    output.mkdir(parents=True, exist_ok=True)
    publication = build(ROOT)
    suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"))
    result = unittest.TextTestRunner(verbosity=2, resultclass=RecordedResult).run(suite)
    files = sorted((ROOT / "src").rglob("*.py")) + sorted((ROOT / "tests").glob("*.py")) + [Path(__file__)]
    code_hashes = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    report = {"scope": "M1_ONLY_NO_LLM_OR_BOOKING_EVALUATION", "ran_at_utc": datetime.now(timezone.utc).isoformat(),
              "python": platform.python_version(), "sqlite": sqlite3.sqlite_version, "platform": platform.system(),
              "publication": publication, "tests_run": result.testsRun, "passed": result.wasSuccessful(),
              "records": result.records, "code_sha256": code_hashes}
    write_json(output / "test-results.json", report)
    cases = [
        ("K01", "改签", "BHA", False, "2026-09-18T00:00:00Z", "FOUND", ["BHA:2.1", "BHA:2.2", "BHA:Appendix A"]),
        ("K02", "退票", "NSA", False, "2026-09-18T00:00:00Z", "FOUND", ["NSA:3.1", "NSA:3.2", "NSA:6.2"]),
        ("K03", "行李", "STA", False, "2026-09-18T00:00:00Z", "FOUND", ["STA:7", "STA:7.1", "STA:7.3"]),
        ("K04", "行李", None, True, "2026-09-18T00:00:00Z", "FOUND", ["NSA:7", "BHA:7", "STA:7"]),
        ("K05", "退票", None, False, "2026-09-18T00:00:00Z", "NEEDS_CONTEXT", []),
        ("K06", "宠物可以托运行李吗", "BHA", False, "2026-09-18T00:00:00Z", "NO_EVIDENCE", ["BHA:10"]),
        ("K07", "改签", "BHA", False, "2026-06-30T23:59:59Z", "UNSUPPORTED_PERIOD", []),
        ("K08", "service-desk", "NSA", False, "2026-09-18T00:00:00Z", "NO_EVIDENCE", []),
        ("K09", "降价与税费可以轧差抵扣吗", "STA", False, "2026-09-18T00:00:00Z", "FOUND", ["STA:2.2", "STA:3.1"]),
        ("K10", "Northstar refund", "BHA", False, "2026-09-18T00:00:00Z", "NEEDS_CONTEXT", [])
    ]
    kb = KnowledgeBase(ROOT / "data/knowledge")
    retrieval = []
    full_example = None
    for case, question, airline, compare, request_at, expected, required in cases:
        response = kb.search(question, airline, compare, request_at)
        ids = [c["id"] for c in response["evidence"]]
        success = response["status"] == expected and set(required).issubset(ids)
        retrieval.append({"case": case, "input": {"question": question, "airline": airline, "compare": compare, "request_at": request_at},
                          "expected_status": expected, "required_source_ids": required,
                          "actual_status": response["status"], "result": "PASS" if success else "FAIL",
                          "release_id": response["release_id"], "retrieved_source_ids": ids,
                          "candidate_ids": [c["id"] for c in response["candidates"]], "trace": response["trace"]})
        if case == "K09":
            full_example = response
    write_json(output / "retrieval-results.json", retrieval)
    write_json(output / "financial-evidence-example.json", full_example)
    _, manifest = resolve_release(ROOT / "data/knowledge")
    write_json(output / "verified-manifest.json", manifest)
    passed = result.wasSuccessful() and all(case["result"] == "PASS" for case in retrieval)
    print(json.dumps({"passed": passed, "module_tests": result.testsRun, "retrieval_cases": len(cases), "release_id": publication["release_id"]}))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
