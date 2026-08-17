from __future__ import annotations

import importlib.util
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Iterable
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).parents[1] / "analyze_codex_turn_state.py"
FIXTURE_PATH = Path(__file__).with_name("codex-trace-2026-08-16.jsonl")
TURN_STATE_PATH = (
    Path(__file__).parents[2] / "packages/providers/src/providers/codex/turn-state.ts"
)


def trace_row(
    *,
    phase: str,
    ts: str,
    request_id: str,
    attempt_id: str,
    arm: str = "treatment",
    action: str = "replay",
    ordinal: int = 1,
    **extra: Any,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "trace_schema_version": 18,
        "phase": phase,
        "ts": ts,
        "request_id": request_id,
        "attempt_id": attempt_id,
    }
    if phase == "request":
        row.update(
            {
                "attempt_ordinal": ordinal,
                "model_out": "gpt-5.6-sol",
                "codex_turn_state_arm": arm,
                "codex_turn_state_request_action": action,
                "codex_turn_state_cohort_id": "eeeeeeeeeeeeeeee",
            }
        )
    row.update(extra)
    return row


def sensitive_strings(value: Any, field: str = "") -> set[str]:
    """Collect fixture sentinels independently of analyzer output logic."""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, nested in value.items():
            found.update(sensitive_strings(nested, str(key)))
    elif isinstance(value, list):
        for nested in value:
            found.update(sensitive_strings(nested, field))
    elif isinstance(value, str):
        sensitive_field = any(
            token in field.lower()
            for token in (
                "account",
                "attempt",
                "cache_key",
                "cohort",
                "hmac",
                "payload",
                "raw_input",
                "request_id",
                "session",
            )
        )
        if sensitive_field or value.startswith(("PRIVATE_", "DO_NOT_LEAK_")):
            found.add(value)
    return found


def load_module():
    spec = importlib.util.spec_from_file_location(
        "analyze_codex_turn_state", SCRIPT_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not import {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


analysis = load_module()


class CodexTurnStateAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.records, cls.files = analysis.load_records([FIXTURE_PATH])
        cls.report = analysis.build_report(cls.records, cls.files)

    def test_requires_explicit_date_scoped_trace_filename(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            unscoped = Path(directory) / "trace.jsonl"
            unscoped.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "explicitly date-scoped"):
                analysis.load_records([unscoped])

    def test_rejects_duplicate_resolved_trace_paths_and_cross_date_records(
        self,
    ) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate trace path"):
            analysis.load_records([FIXTURE_PATH, FIXTURE_PATH.resolve()])

        with tempfile.TemporaryDirectory() as directory:
            renamed = Path(directory) / "codex-trace-2026-08-17.jsonl"
            renamed.write_text(
                json.dumps(
                    trace_row(
                        phase="request",
                        ts="2026-08-16T23:59:59Z",
                        request_id="PRIVATE_CROSS_DATE_REQUEST",
                        attempt_id="PRIVATE_CROSS_DATE_ATTEMPT",
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "UTC date does not match"):
                analysis.load_records([renamed])

    def test_rejects_missing_or_invalid_timestamps_for_trace_phases(self) -> None:
        for label, timestamp in (("missing", None), ("invalid", "not-a-time")):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "codex-trace-2026-08-16.jsonl"
                row = trace_row(
                    phase="response",
                    ts="2026-08-16T01:00:00Z",
                    request_id=f"PRIVATE_{label}_REQUEST",
                    attempt_id=f"PRIVATE_{label}_ATTEMPT",
                )
                if timestamp is None:
                    row.pop("ts")
                else:
                    row["ts"] = timestamp
                path.write_text(json.dumps(row) + "\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "valid timestamp"):
                    analysis.load_records([path])

    def test_quarantines_unsupported_schema_rows_without_legacy_coercion(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "codex-trace-2026-08-16.jsonl"
            rows = [
                trace_row(
                    phase="request",
                    ts="2026-08-16T01:00:00Z",
                    request_id="PRIVATE_SUPPORTED_REQUEST",
                    attempt_id="PRIVATE_SUPPORTED_ATTEMPT",
                ),
                {
                    **trace_row(
                        phase="request",
                        ts="2026-08-16T01:00:01Z",
                        request_id="PRIVATE_LEGACY_REQUEST",
                        attempt_id="",
                    ),
                    "trace_schema_version": 6,
                },
                {
                    **trace_row(
                        phase="request",
                        ts="2026-08-16T01:00:02Z",
                        request_id="PRIVATE_FUTURE_REQUEST",
                        attempt_id="PRIVATE_FUTURE_ATTEMPT",
                    ),
                    "trace_schema_version": 19,
                },
                {
                    **trace_row(
                        phase="request",
                        ts="2026-08-16T01:00:03Z",
                        request_id="PRIVATE_MALFORMED_REQUEST",
                        attempt_id="PRIVATE_MALFORMED_ATTEMPT",
                    ),
                    "trace_schema_version": "18",
                },
                trace_row(
                    phase="request",
                    ts="2026-08-16T01:00:04Z",
                    request_id="PRIVATE_MISSING_SCHEMA_REQUEST",
                    attempt_id="PRIVATE_MISSING_SCHEMA_ATTEMPT",
                ),
                {
                    **trace_row(
                        phase="request",
                        ts="2026-08-16T01:00:05Z",
                        request_id="PRIVATE_TOO_OLD_REQUEST",
                        attempt_id="PRIVATE_TOO_OLD_ATTEMPT",
                    ),
                    "trace_schema_version": 5,
                },
            ]
            rows[4].pop("trace_schema_version")
            path.write_text(
                "".join(json.dumps(row) + "\n" for row in rows),
                encoding="utf-8",
            )
            records, files = analysis.load_records([path])
            self.assertEqual(len(records), 2)
            self.assertEqual(
                files[0]["excluded_rows_by_reason"],
                {
                    "future_schema": 1,
                    "malformed_schema": 1,
                    "missing_schema": 1,
                    "unsupported_legacy_schema": 1,
                },
            )
            report = analysis.build_report(records, files)
            self.assertEqual(report["data_quality"]["source_rows"], 6)
            self.assertEqual(report["data_quality"]["schema_rows_excluded"], 4)
            self.assertFalse(analysis.is_legacy_join_eligible(rows[3]))
            self.assertFalse(analysis.is_legacy_join_eligible(rows[4]))

    def test_enforces_configurable_per_file_byte_and_row_guards(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "codex-trace-2026-08-16.jsonl"
            row = trace_row(
                phase="request",
                ts="2026-08-16T01:00:00Z",
                request_id="PRIVATE_GUARD_REQUEST",
                attempt_id="PRIVATE_GUARD_ATTEMPT",
            )
            path.write_text(json.dumps(row) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "byte limit"):
                analysis.load_records([path], max_file_bytes=1)
            with self.assertRaisesRegex(ValueError, "row limit"):
                analysis.load_records([path], max_rows_per_file=0)

    def test_uses_final_non_aborted_attempt_for_mechanism_and_reports_itt(
        self,
    ) -> None:
        quality = self.report["data_quality"]
        self.assertEqual(quality["physical_request_records"], 6)
        self.assertEqual(quality["final_observed_logical_requests"], 5)
        self.assertEqual(quality["logical_request_ids_with_multiple_attempts"], 1)
        self.assertEqual(quality["aborted_attempt_ids_excluded"], 1)

        replay = self.report["q1"]["replay"]
        self.assertEqual(replay["requests"], 1)
        self.assertEqual(replay["joined_responses"], 1)
        self.assertEqual(replay["models"], {"gpt-5.6-sol": 1})
        self.assertEqual(self.report["q1"]["would_replay"]["requests"], 1)
        self.assertEqual(self.report["q1"]["itt_replay"]["requests"], 1)
        self.assertEqual(self.report["q1"]["itt_would_replay"]["requests"], 1)
        self.assertEqual(self.report["q1"]["crossovers"]["q1_action_crossovers"], 0)

    def test_excludes_crossed_over_attempt_from_primary_q1_mechanism(self) -> None:
        records = [
            trace_row(
                phase="request",
                ts="2026-08-16T02:00:00Z",
                request_id="PRIVATE_CROSSOVER_REQUEST",
                attempt_id="PRIVATE_CROSSOVER_FIRST",
                arm="treatment",
                action="replay",
                ordinal=1,
                codex_turn_state_replay_applied=True,
            ),
            trace_row(
                phase="request",
                ts="2026-08-16T02:00:01Z",
                request_id="PRIVATE_CROSSOVER_REQUEST",
                attempt_id="PRIVATE_CROSSOVER_FINAL",
                arm="control",
                action="would_replay",
                ordinal=2,
                codex_turn_state_replay_applied=False,
                model_out="gpt-5.6-terra",
            ),
            trace_row(
                phase="response",
                ts="2026-08-16T02:00:02Z",
                request_id="PRIVATE_CROSSOVER_REQUEST",
                attempt_id="PRIVATE_CROSSOVER_FINAL",
                input_tokens=100,
                cache_read_input_tokens=30,
                cache_creation_input_tokens=0,
                cache_measurement_available=True,
            ),
        ]
        report = analysis.build_report(records, [])
        self.assertEqual(report["q1"]["replay"]["requests"], 0)
        self.assertEqual(report["q1"]["would_replay"]["requests"], 1)
        self.assertEqual(report["q1"]["would_replay"]["models"], {"gpt-5.6-terra": 1})
        self.assertEqual(report["q1"]["itt_replay"]["requests"], 1)
        self.assertEqual(report["q1"]["itt_would_replay"]["requests"], 0)
        self.assertEqual(report["q1"]["crossovers"]["arm_crossovers"], 1)
        self.assertEqual(report["q1"]["crossovers"]["q1_action_crossovers"], 1)
        self.assertEqual(
            report["q1"]["crossovers"]["q1_action_paths"],
            {"replay -> would_replay": 1},
        )

    def test_retry_uses_final_cohort_for_turn_lineage_and_database_arm(self) -> None:
        final_cohort = "bbbbbbbbbbbbbbbb"
        records = [
            trace_row(
                phase="request",
                ts="2026-08-16T01:59:00Z",
                request_id="PRIVATE_FINAL_COHORT_PREDECESSOR",
                attempt_id="PRIVATE_FINAL_COHORT_PREDECESSOR_ATTEMPT",
                arm="control",
                action="would_replay",
                codex_turn_state_cohort_id=final_cohort,
            ),
            trace_row(
                phase="response",
                ts="2026-08-16T01:59:01Z",
                request_id="PRIVATE_FINAL_COHORT_PREDECESSOR",
                attempt_id="PRIVATE_FINAL_COHORT_PREDECESSOR_ATTEMPT",
                input_tokens=100,
                cache_read_input_tokens=20,
                cache_creation_input_tokens=0,
            ),
            trace_row(
                phase="request",
                ts="2026-08-16T02:00:00Z",
                request_id="PRIVATE_RETRY_LINEAGE",
                attempt_id="PRIVATE_RETRY_LINEAGE_FIRST",
                arm="treatment",
                action="replay",
                ordinal=1,
                codex_turn_state_cohort_id="aaaaaaaaaaaaaaaa",
            ),
            trace_row(
                phase="request",
                ts="2026-08-16T02:00:01Z",
                request_id="PRIVATE_RETRY_LINEAGE",
                attempt_id="PRIVATE_RETRY_LINEAGE_FINAL",
                arm="control",
                action="would_replay",
                ordinal=2,
                codex_turn_state_cohort_id=final_cohort,
            ),
            trace_row(
                phase="response",
                ts="2026-08-16T02:00:02Z",
                request_id="PRIVATE_RETRY_LINEAGE",
                attempt_id="PRIVATE_RETRY_LINEAGE_FINAL",
                input_tokens=100,
                cache_read_input_tokens=30,
                cache_creation_input_tokens=0,
            ),
        ]
        logical = analysis.make_samples(records, logical=True)
        retry = next(
            sample
            for sample in logical
            if sample.request.get("request_id") == "PRIVATE_RETRY_LINEAGE"
        )
        self.assertEqual(retry.turn, "follow_up_observed")
        self.assertIsNotNone(retry.previous)
        self.assertEqual(
            retry.previous.request.get("request_id"),
            "PRIVATE_FINAL_COHORT_PREDECESSOR",
        )
        self.assertEqual(retry.request.get("codex_turn_state_cohort_id"), final_cohort)
        report = analysis.build_report(records, [])
        self.assertEqual(
            report["q1"]["would_replay"]["turns"],
            {"first_observed": 1, "follow_up_observed": 1},
        )
        self.assertEqual(report["q1"]["itt_replay"]["requests"], 1)
        self.assertEqual(report["q1"]["crossovers"]["arm_crossovers"], 1)

        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "history.db"
            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                CREATE TABLE requests (
                    id TEXT PRIMARY KEY,
                    prompt_tokens INTEGER,
                    input_tokens INTEGER,
                    cache_read_input_tokens INTEGER,
                    cache_creation_input_tokens INTEGER,
                    client_session_id TEXT,
                    account_used TEXT,
                    timestamp INTEGER
                )
                """
            )
            connection.execute(
                "INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "PRIVATE_RETRY_LINEAGE",
                    100,
                    70,
                    30,
                    0,
                    "PRIVATE_RETRY_SESSION",
                    "PRIVATE_ACCOUNT",
                    0,
                ),
            )
            connection.commit()
            connection.close()

            validation = analysis.database_validation(logical, database_path)
            self.assertEqual(validation["distinct_sessions"]["arm:control"], 1)
            self.assertNotIn("arm:treatment", validation["distinct_sessions"])
            self.assertEqual(validation["distinct_sessions"]["action:would_replay"], 1)

    def test_reports_semantic_and_legacy_cache_share_denominators(self) -> None:
        replay = self.report["q1"]["replay"]
        self.assertEqual(replay["trace_total_input_tokens"], 100)
        self.assertEqual(replay["uncached_input_tokens"], 50)
        self.assertEqual(replay["cache_read_input_tokens"], 40)
        self.assertEqual(replay["cache_creation_input_tokens"], 10)
        self.assertEqual(replay["cache_read_share_token_weighted_pct"], 40.0)
        self.assertEqual(replay["cache_read_share_median_pct"], 40.0)
        self.assertEqual(replay["legacy_double_count_share_token_weighted_pct"], 26.7)
        self.assertEqual(replay["legacy_double_count_share_median_pct"], 26.7)

    def test_semantic_cache_share_survives_missing_cache_creation(self) -> None:
        sample = analysis.Sample(
            request={
                "model_out": "gpt-5.6-sol",
                "codex_turn_state_arm": "treatment",
                "codex_turn_state_request_action": "replay",
            },
            response={
                "input_tokens": 100,
                "cache_read_input_tokens": 40,
                "cache_creation_input_tokens": None,
                "cache_measurement_available": True,
            },
            attempts=[],
            provenance={
                "codex_turn_state_arm": "treatment",
                "codex_turn_state_request_action": "replay",
            },
            logical_timestamp=None,
        )
        summary = analysis.summarize([sample])
        self.assertEqual(summary["semantic_cache_measured_responses"], 1)
        self.assertEqual(summary["component_breakdown_measured_responses"], 0)
        self.assertEqual(summary["cache_read_share_token_weighted_pct"], 40.0)
        self.assertEqual(summary["cache_read_share_median_pct"], 40.0)
        self.assertIsNone(summary["uncached_input_tokens"])
        self.assertIsNone(summary["cache_creation_input_tokens"])
        self.assertIsNone(summary["legacy_double_count_share_median_pct"])

    def test_reports_prefix_retention_as_counts_without_fingerprints(self) -> None:
        transitions = self.report["q1"]["replay_transitions"]
        self.assertEqual(transitions["prefix"], {"retained_exact_prior_full_prefix": 1})
        serialized = json.dumps(self.report, sort_keys=True)
        self.assertNotIn("PRIVATE_PREFIX_BOUNDARY", serialized)
        self.assertNotIn("PRIVATE_APPENDED_CUMULATIVE_INPUT", serialized)

        final_inputs = self.report["q2"]["appended_final_full_input_fingerprints"]
        self.assertEqual(final_inputs["requests"], 1)
        self.assertEqual(final_inputs["available"], 1)
        self.assertEqual(final_inputs["distinct_final_full_input_fingerprints"], 1)
        self.assertEqual(
            final_inputs["largest_repeated_full_input_fingerprint_cluster"], 1
        )

    def test_output_never_contains_identifiers_or_payload_values(self) -> None:
        serialized = json.dumps(self.report, sort_keys=True)
        fixture_rows = [
            json.loads(line) for line in FIXTURE_PATH.read_text().splitlines()
        ]
        forbidden = set().union(*(sensitive_strings(row) for row in fixture_rows))
        self.assertIn("PRIVATE_CANONICAL_ACCOUNT", forbidden)
        self.assertIn("PRIVATE_NESTED_PAYLOAD", forbidden)
        for value in forbidden:
            with self.subTest(value=value):
                self.assertNotIn(value, serialized)

        completed = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), str(FIXTURE_PATH)],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        direct_cli_output = completed.stdout + completed.stderr
        for value in forbidden:
            with self.subTest(cli_value=value):
                self.assertNotIn(value, direct_cli_output)

        appended = self.report["q2"]
        self.assertEqual(appended["appended_input_suppressed_physical"]["requests"], 1)
        self.assertEqual(appended["appended_input_suppressed"]["requests"], 1)
        self.assertEqual(
            appended["appended_spillover"]["immediate_next_action"],
            {"no_pending": 1},
        )
        self.assertEqual(appended["appended_input_signature"]["nudge_count_total"], 2)

    def test_appended_spillover_skips_same_logical_request_retry(self) -> None:
        records = [
            trace_row(
                phase="request",
                ts="2026-08-16T03:00:00Z",
                request_id="PRIVATE_APPENDED_LOGICAL",
                attempt_id="PRIVATE_APPENDED_FIRST",
                arm="ineligible",
                action="appended_input_suppressed",
                ordinal=1,
            ),
            trace_row(
                phase="request",
                ts="2026-08-16T03:00:01Z",
                request_id="PRIVATE_APPENDED_LOGICAL",
                attempt_id="PRIVATE_APPENDED_RETRY",
                arm="ineligible",
                action="appended_input_suppressed",
                ordinal=2,
            ),
            trace_row(
                phase="response",
                ts="2026-08-16T03:00:02Z",
                request_id="PRIVATE_APPENDED_LOGICAL",
                attempt_id="PRIVATE_APPENDED_RETRY",
                stop_reason="tool_use",
                input_tokens=10,
                cache_read_input_tokens=5,
                cache_creation_input_tokens=0,
            ),
            trace_row(
                phase="request",
                ts="2026-08-16T03:00:03Z",
                request_id="PRIVATE_NEXT_LOGICAL",
                attempt_id="PRIVATE_NEXT_ATTEMPT",
                action="no_pending",
            ),
        ]
        logical = analysis.make_samples(records, logical=True)
        spillover = analysis.appended_spillover(logical)
        self.assertEqual(spillover["appended_tool_use_responses"], 1)
        self.assertEqual(spillover["immediate_next_action"], {"no_pending": 1})
        self.assertEqual(spillover["ambiguous_chronology"], 0)
        self.assertEqual(spillover["missing_chronology"], 0)

    def test_python_allowlists_match_canonical_turn_state_arrays(self) -> None:
        source = TURN_STATE_PATH.read_text(encoding="utf-8")
        expected: Iterable[tuple[str, set[str]]] = (
            ("CODEX_TURN_STATE_ARMS", analysis.TURN_STATE_ARMS),
            ("CODEX_TURN_STATE_REQUEST_ACTIONS", analysis.TURN_STATE_REQUEST_ACTIONS),
            ("CODEX_TURN_STATE_TERMINAL_ACTIONS", analysis.TURN_STATE_TERMINAL_ACTIONS),
        )
        for export_name, python_values in expected:
            with self.subTest(export_name=export_name):
                match = re.search(
                    rf"export const {export_name} = \[(.*?)\] as const;",
                    source,
                    flags=re.DOTALL,
                )
                self.assertIsNotNone(match)
                typescript_values = set(re.findall(r'"([^"]+)"', match.group(1)))
                self.assertEqual(python_values, typescript_values)

    def test_database_reconciliation_is_read_only_and_uses_additive_fields(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "history.db"
            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                CREATE TABLE requests (
                    id TEXT PRIMARY KEY,
                    prompt_tokens INTEGER,
                    input_tokens INTEGER,
                    cache_read_input_tokens INTEGER,
                    cache_creation_input_tokens INTEGER,
                    client_session_id TEXT,
                    account_used TEXT,
                    timestamp INTEGER
                )
                """
            )
            connection.execute(
                "INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "PRIVATE_REQUEST_REPLAY",
                    100,
                    50,
                    40,
                    10,
                    "PRIVATE_SESSION",
                    "PRIVATE_ACCOUNT",
                    0,
                ),
            )
            connection.commit()
            connection.close()

            read_only = analysis.open_read_only_database(database_path)
            try:
                self.assertEqual(
                    read_only.execute("PRAGMA query_only").fetchone()[0], 1
                )
                with self.assertRaises(sqlite3.OperationalError):
                    read_only.execute("CREATE TABLE forbidden_write (id INTEGER)")
            finally:
                read_only.close()

            logical = analysis.make_samples(self.records, logical=True)
            validation = analysis.database_validation(logical, database_path)
            self.assertEqual(validation["database_open_mode"], "mode=ro+query_only")
            comparisons = validation["comparisons"]
            self.assertEqual(comparisons["trace_total_equals_db_prompt"], 1)
            self.assertEqual(comparisons["db_additive_components_equal_prompt"], 1)
            self.assertEqual(comparisons["semantic_cache_share_matches"], 1)
            serialized = json.dumps(validation, sort_keys=True)
            self.assertNotIn("PRIVATE_REQUEST_REPLAY", serialized)
            self.assertNotIn("PRIVATE_SESSION", serialized)
            self.assertNotIn("PRIVATE_ACCOUNT", serialized)


if __name__ == "__main__":
    unittest.main()
