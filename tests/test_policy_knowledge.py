import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from airline_kb import KnowledgeBase
from airline_kb.build import build
from airline_kb.storage import KnowledgeError, activate, read_json, resolve_release, write_json

ROOT = Path(__file__).resolve().parents[1]
NOW = "2026-09-18T00:00:00Z"


class PolicyKnowledgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.base = Path(cls.temporary.name) / "base"
        shutil.copytree(ROOT / "airline-policies", cls.base / "airline-policies")
        shutil.copytree(ROOT / "data/policy-inputs", cls.base / "data/policy-inputs")
        cls.result = build(cls.base)
        cls.store = cls.base / "data/knowledge"
        cls.release, cls.manifest = resolve_release(cls.store)
        cls.kb = KnowledgeBase(cls.store)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def query(self, question, airline="NSA", **kwargs):
        return self.kb.search(question, airline=airline, request_at=kwargs.pop("request_at", NOW), **kwargs)

    def sandbox(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        target = Path(directory.name) / "project"
        shutil.copytree(self.base, target)
        return target

    def assert_sections(self, result, sections, code):
        ids = {c["id"] for c in result["evidence"]}
        self.assertTrue({f"{code}:{s}" for s in sections}.issubset(ids))

    def test_all_sources_pages_sections_and_tables(self):
        self.assertEqual(self.manifest["counts"], {"documents": 3, "pages": 18, "chunks": 75, "tables": 13})
        self.assertEqual(set(self.manifest["reviewed_sources"]), {"NSA", "BHA", "STA"})
        self.assertEqual(self.manifest["purpose"], "evidence_only")
        self.assertIsNone(self.manifest["business_rules_package"])

    def test_no_assignment_in_business_corpus(self):
        docs = read_json(self.release / "documents.json")
        self.assertTrue(all(d["path"].startswith("airline-policies/") for d in docs))
        self.assertNotIn("Engineering Assignment", json.dumps(docs))

    def test_every_non_footer_line_preserved_in_sections(self):
        chunks = read_json(self.release / "chunks.json")
        for doc in read_json(self.release / "documents.json"):
            lines = [line for page in doc["pages"] for line in page["text"].splitlines()
                     if not re.fullmatch(r".*\| v[\d.]+ \| Passenger Policies \d+ / \d+", line)]
            actual = "\n".join(c["text"] for c in chunks if c["airline"] == doc["airline"])
            self.assertEqual(actual, "\n".join(lines))

    def test_reviewed_change_table_values(self):
        chunks = {c["id"]: c for c in read_json(self.release / "chunks.json")}
        nsa = chunks["NSA:2.1"]["tables"][0]["rows"]
        self.assertEqual(nsa[1:], [["Economy Basic", "USD 70", "Not permitted"],
                                  ["Economy Standard", "USD 25", "USD 60"],
                                  ["Economy Flex", "USD 0", "USD 0"]])
        self.assertEqual(chunks["STA:2.1"]["tables"][0]["rows"][2][1], "Domestic USD 20; international USD 65")
        self.assertIn("USD 55 current / USD 85 previous", chunks["BHA:2.1"]["tables"][0]["rows"][2])

    def test_refund_table_preserves_credit_vs_original_payment(self):
        chunks = {c["id"]: c for c in read_json(self.release / "chunks.json")}
        self.assertEqual(chunks["NSA:3"]["tables"][0]["rows"][2][1], "Travel credit less USD 40")
        self.assertEqual(chunks["BHA:3"]["tables"][0]["rows"][3][1], "Travel credit less USD 30")
        sta = chunks["STA:3"]["tables"][0]["rows"][3][2]
        self.assertEqual(sta, "Domestic original payment less USD 20; international credit less USD 75")

    def test_nsa_change_brings_positive_difference_taxes_disruption_and_authority(self):
        result = self.query("改签")
        self.assertEqual(result["status"], "FOUND")
        self.assert_sections(result, ["1.1", "2.1", "2.2", "2.3", "3.2", "5", "6", "6.1", "6.2", "8", "8.1"], "NSA")

    def test_refund_brings_taxes_extras_scope_and_disruption_for_each_airline(self):
        for code in ["NSA", "BHA", "STA"]:
            result = self.query("退票", code)
            self.assert_sections(result, ["3", "3.1", "3.2", "4", "5", "6", "6.1", "6.2", "9"], code)
            self.assertTrue(all(c["airline"] == code for c in result["evidence"] + result["candidates"]))

    def test_bluehaven_issuance_conditions_and_appendix_are_not_dropped(self):
        result = self.query("改签", "BHA")
        self.assert_sections(result, ["2.1", "Appendix A"], "BHA")
        text = "\n".join(c["text"] for c in result["evidence"])
        self.assertIn("USD 85", text)
        self.assertIn("USD 55", text)
        self.assertIn("2026-07-01 00:00:00 UTC", text)
        self.assertIn("original_issued_at", result["required_booking_facts"])

    def test_netting_retrieves_explicit_non_offset_and_separate_tax_rules(self):
        result = self.query("降价与涨价可以轧差抵扣吗")
        self.assert_sections(result, ["2.2", "3.1"], "NSA")
        text = next(c["text"] for c in result["evidence"] if c["section"] == "2.2")
        self.assertIn("A lower fare creates no refund or credit and cannot offset a change", text)
        self.assertIn("payment method separately", text)

    def test_chinese_and_english_known_intents_have_same_essential_evidence(self):
        chinese = self.query("改签", "STA")
        english = self.query("reschedule", "STA")
        self.assertEqual([c["id"] for c in chinese["evidence"]], [c["id"] for c in english["evidence"]])

    def test_baggage_has_size_weight_purchase_and_transfer_conditions(self):
        result = self.query("行李", "STA")
        self.assert_sections(result, ["1", "3.2", "7", "7.1", "7.2", "7.3"], "STA")
        text = "\n".join(c["text"] for c in result["evidence"])
        for literal in ["158 cm", "55 x 35 x 25 cm", "USD 50", "23 kg"]:
            self.assertIn(literal, text)

    def test_unknown_airline_requires_context(self):
        result = self.query("可以退款吗", None)
        self.assertEqual(result["status"], "NEEDS_CONTEXT")
        self.assertEqual(result["evidence"], [])

    def test_airline_can_be_resolved_from_question(self):
        result = self.query("Bluehaven 改签", None)
        self.assertEqual(result["airlines"], ["BHA"])

    def test_explicit_airline_conflict_does_not_silently_choose(self):
        self.assertEqual(self.query("Northstar refund", "BHA")["status"], "NEEDS_CONTEXT")

    def test_unreviewed_airline_is_not_substituted(self):
        self.assertEqual(self.query("refund", "Delta")["status"], "NO_EVIDENCE")

    def test_comparison_is_explicit_and_grouped_by_source(self):
        self.assertEqual(self.query("NSA BHA refund", None)["status"], "NEEDS_CONTEXT")
        result = self.query("行李", None, compare=True)
        self.assertEqual(result["airlines"], ["BHA", "NSA", "STA"])
        self.assertEqual({c["airline"] for c in result["evidence"]}, {"BHA", "NSA", "STA"})

    def test_request_before_effective_is_not_answered_with_current_rules(self):
        self.assertEqual(self.query("改签", "BHA", request_at="2026-06-30T23:59:59Z")["status"], "UNSUPPORTED_PERIOD")
        self.assertEqual(self.query("改签", "BHA", request_at="2026-07-01T00:00:00Z")["status"], "FOUND")

    def test_timezone_is_required_and_equivalent_instants_match(self):
        with self.assertRaises(KnowledgeError):
            self.query("改签", request_at="2026-09-18T00:00:00")
        utc = self.query("改签", "BHA", request_at="2026-07-01T00:00:00Z")
        local = self.query("改签", "BHA", request_at="2026-07-01T08:00:00+08:00")
        self.assertEqual(utc["request_at"], local["request_at"])

    def test_documented_unknown_does_not_become_permission(self):
        result = self.query("宠物可以托运行李吗", "BHA")
        self.assertEqual(result["status"], "NO_EVIDENCE")
        self.assertEqual(result["uncovered_topics"], ["pet_transport"])
        self.assert_sections(result, ["10", "7"], "BHA")

    def test_compensation_returns_scope_statement(self):
        result = self.query("延误酒店赔偿", "STA")
        self.assertEqual(result["status"], "NO_EVIDENCE")
        self.assert_sections(result, ["6.3"], "STA")

    def test_unknown_word_has_no_manufactured_evidence(self):
        result = self.query("flibbertigibbet")
        self.assertEqual(result["status"], "NO_EVIDENCE")
        self.assertEqual(result["evidence"], [])

    def test_full_text_fallback_returns_candidates_not_a_guaranteed_answer(self):
        result = self.query("service-desk")
        self.assertEqual(result["status"], "NO_EVIDENCE")
        self.assertGreater(len(result["candidates"]), 0)
        self.assertEqual(result["evidence"], [])

    def test_no_generated_price_or_booking_authorization(self):
        result = self.query("改签多少钱")
        self.assertEqual(result["booking_decision"], "NOT_EVALUATED")
        for forbidden in ["approved", "quote", "total_due", "operation_id"]:
            self.assertNotIn(forbidden, result)

    def test_every_citation_points_to_the_immutable_matching_pdf(self):
        result = self.query("退款", "STA")
        for chunk in result["evidence"]:
            cite = chunk["citation"]
            pdf = Path(cite["snapshot_pdf"])
            self.assertTrue(pdf.is_relative_to(self.release))
            self.assertEqual(hashlib.sha256(pdf.read_bytes()).hexdigest(), cite["source_sha256"])
            self.assertTrue(all(1 <= p <= 6 for p in cite["pages"]))

    def test_identical_import_is_idempotent(self):
        result = build(self.base)
        self.assertEqual(result["release_id"], self.result["release_id"])
        self.assertTrue(result["reused"])

    def test_source_change_cannot_publish_without_review(self):
        root = self.sandbox()
        source = root / "airline-policies/bluehaven-airways/Passenger_Policies.pdf"
        source.write_bytes(source.read_bytes() + b"\n% unreviewed update\n")
        with self.assertRaises(KnowledgeError) as raised:
            build(root)
        self.assertEqual(raised.exception.code, "REVIEW_REQUIRED")
        self.assertEqual((root / "data/knowledge/CURRENT").read_text().strip(), self.result["release_id"])
        self.assertEqual(KnowledgeBase(root / "data/knowledge").search("改签", "BHA", request_at=NOW)["status"], "FOUND")

    def test_source_replaced_during_parse_cannot_change_verified_bytes(self):
        import pdfplumber
        root = self.sandbox()
        source = root / "airline-policies/bluehaven-airways/Passenger_Policies.pdf"
        original_open = pdfplumber.open
        modified = False

        def replace_input_then_parse(stream, *args, **kwargs):
            nonlocal modified
            if not modified:
                source.write_bytes(b"a concurrent unreviewed replacement")
                modified = True
            return original_open(stream, *args, **kwargs)

        with patch("pdfplumber.open", side_effect=replace_input_then_parse):
            result = build(root)
        self.assertEqual(result["release_id"], self.result["release_id"])
        path, _ = resolve_release(root / "data/knowledge")
        self.assertEqual((path / "sources/BHA.pdf").read_bytes(), (self.release / "sources/BHA.pdf").read_bytes())

    def test_input_metadata_describes_the_config_captured_at_build_start(self):
        import airline_kb.build as builder
        root = self.sandbox()
        config_path = root / "data/policy-inputs/retrieval.json"
        original = builder.extract_document
        changed = False

        def edit_config_then_extract(*args):
            nonlocal changed
            if not changed:
                config = read_json(config_path)
                config["topics"]["change"]["aliases"].append("concurrentconfigedit")
                write_json(config_path, config)
                changed = True
            return original(*args)

        with patch("airline_kb.build.extract_document", side_effect=edit_config_then_extract):
            result = build(root)
        self.assertEqual(result["release_id"], self.result["release_id"])

    def test_table_baseline_mismatch_blocks_publication(self):
        root = self.sandbox()
        path = root / "data/policy-inputs/reviewed-tables.json"
        data = read_json(path)
        data["NSA"]["2"][0][2][1] = "USD 999"
        write_json(path, data)
        with self.assertRaises(KnowledgeError):
            build(root)
        self.assertEqual((root / "data/knowledge/CURRENT").read_text().strip(), self.result["release_id"])

    def test_missing_section_mapping_blocks_publication(self):
        root = self.sandbox()
        path = root / "data/policy-inputs/retrieval.json"
        data = read_json(path)
        data["topics"]["refund"]["sections"].append("404")
        write_json(path, data)
        with self.assertRaises(KnowledgeError):
            build(root)

    def test_corrupted_index_is_unavailable_not_partial_success(self):
        root = self.sandbox()
        index = root / "data/knowledge/releases" / self.result["release_id"] / "index.sqlite"
        index.write_bytes(b"broken")
        with self.assertRaises(KnowledgeError) as raised:
            KnowledgeBase(root / "data/knowledge").search("refund", "NSA", request_at=NOW)
        self.assertEqual(raised.exception.code, "UNAVAILABLE")

    def test_parallel_queries_never_mix_airlines(self):
        def run(i):
            code = ["NSA", "BHA", "STA"][i % 3]
            result = self.query("改签退款", code)
            return code, result
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(run, range(120)))
        for code, result in results:
            self.assertEqual(result["status"], "FOUND")
            self.assertTrue(all(c["airline"] == code for c in result["evidence"] + result["candidates"]))
            self.assertEqual(result["release_id"], self.result["release_id"])

    def test_concurrent_import_processes_publish_one_identical_snapshot(self):
        root = self.sandbox()
        store = root / "fresh-store"
        command = [sys.executable, "-m", "airline_kb", "--root", str(root), "--store", str(store), "build"]
        environment = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
        processes = [subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
        results = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual(process.returncode, 0, stderr + stdout)
            results.append(json.loads(stdout))
        self.assertEqual(len({r["release_id"] for r in results}), 1)
        self.assertEqual(len(list((store / "releases").iterdir())), 1)
        self.assertEqual(resolve_release(store)[1]["counts"]["chunks"], 75)

    def test_new_publication_readers_and_explicit_history_are_consistent(self):
        root = self.sandbox()
        store = root / "data/knowledge"
        config_path = root / "data/policy-inputs/retrieval.json"
        data = read_json(config_path)
        data["topics"]["change"]["aliases"].append("newretrievalalias")
        write_json(config_path, data)
        kb = KnowledgeBase(store)
        old = self.result["release_id"]
        with ThreadPoolExecutor(max_workers=8) as pool:
            readers = [pool.submit(kb.search, "newretrievalalias", "BHA", False, NOW) for _ in range(80)]
            publication = pool.submit(build, root)
            results = [f.result() for f in readers]
            new = publication.result()["release_id"]
        self.assertNotEqual(new, old)
        for result in results:
            self.assertIn(result["release_id"], [old, new])
            self.assertEqual(result["status"], "NO_EVIDENCE" if result["release_id"] == old else "FOUND")
            self.assertTrue(all(c["citation"]["release_id"] == result["release_id"] for c in result["evidence"]))
        self.assertEqual(kb.search("newretrievalalias", "BHA", request_at=NOW)["status"], "FOUND")
        self.assertEqual(kb.search("newretrievalalias", "BHA", request_at=NOW, release_id=old)["status"], "NO_EVIDENCE")
        activate(store, old)
        self.assertEqual(kb.search("newretrievalalias", "BHA", request_at=NOW)["status"], "NO_EVIDENCE")

    def test_failure_before_pointer_replace_leaves_previous_release_active(self):
        root = self.sandbox()
        path = root / "data/policy-inputs/retrieval.json"
        config = read_json(path)
        config["topics"]["change"]["aliases"].append("unpublishedalias")
        write_json(path, config)
        with patch("airline_kb.storage.os.replace", side_effect=OSError("simulated publication failure")):
            with self.assertRaises(OSError):
                build(root)
        store = root / "data/knowledge"
        self.assertEqual((store / "CURRENT").read_text().strip(), self.result["release_id"])
        self.assertEqual(KnowledgeBase(store).search("unpublishedalias", "BHA", request_at=NOW)["status"], "NO_EVIDENCE")

    def test_invalid_inputs_and_release_path_traversal_fail_closed(self):
        for question in ["", " ", "x" * 4001, None]:
            with self.assertRaises(KnowledgeError):
                self.kb.search(question, "NSA")
        with self.assertRaises(KnowledgeError):
            self.query("退款", release_id="../../elsewhere")


if __name__ == "__main__":
    unittest.main(verbosity=2)
