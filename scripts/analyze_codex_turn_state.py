#!/usr/bin/env python3
"""Privacy-safe, read-only Codex turn-state analysis for issue #199.

Methodology
-----------
* Every input must be an explicitly named ``codex-trace-YYYY-MM-DD.jsonl``
  file. This prevents accidental pre-deployment/all-history aggregation.
* ``attempt_aborted`` records and the physical attempts they name are removed
  before analysis, matching the repository trace analyzer.
* Schema 9+ request/response records join one-to-one by ``attempt_id``. The
  unique ``request_id`` compatibility join is limited to schema 6-8 records.
* Logical results use the final observed, non-aborted Codex attempt for cache
  measurement and mechanism classification. First-attempt experiment intent is
  reported separately, including retry crossovers. The trace cannot reveal a
  later cross-provider terminal attempt.
* Trace ``input_tokens`` is the cache-inclusive prompt total. The request DB
  stores that total in ``prompt_tokens`` and stores additive uncached/read/write
  buckets in ``input_tokens``, ``cache_read_input_tokens``, and
  ``cache_creation_input_tokens``. The semantic cache-read share is therefore
  ``cache_read / trace_input``. The historical double-count formula is also
  reported explicitly so issue measurements can be reconciled.

Privacy and safety
------------------
Request/attempt/session/cohort IDs, HMACs, prompt-cache keys, accounts, raw
prompts, and payloads are used only as in-memory join/equality keys and are
never emitted. Unknown categorical values are collapsed to ``unknown``. This
script makes no network calls. If ``--database`` is supplied, SQLite is opened
with URI ``mode=ro`` and ``PRAGMA query_only=ON``; it is never modified.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sqlite3
import statistics
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

TRACE_NAME = re.compile(r"^codex-trace-(\d{4}-\d{2}-\d{2})\.jsonl$")
SAFE_COHORT = re.compile(r"^[a-fA-F0-9]{16}$")
LOCAL_TZ = ZoneInfo("America/New_York")
LEGACY_JOIN_MAX_SCHEMA = 8
MIN_SUPPORTED_SCHEMA = 6
MAX_SUPPORTED_SCHEMA = 18
DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024
DEFAULT_MAX_ROWS_PER_FILE = 500_000

TURN_STATE_ARMS = {"observe", "control", "treatment", "ineligible"}
TURN_STATE_REQUEST_ACTIONS = {
    "new_turn",
    "replay",
    "retry_replay",
    "would_replay",
    "observe",
    "no_pending",
    "no_token",
    "concurrent_suppressed",
    "rescue_suppressed",
    "failover_suppressed",
    "custom_endpoint_suppressed",
    "hosted_suppressed",
    "ambiguous_lineage",
    "appended_input_suppressed",
    "evicted_suppressed",
    "missing_binding",
    "account_not_allowlisted",
    "model_not_allowlisted",
    "percent_control",
    "cohort_not_allowlisted",
}
TURN_STATE_TERMINAL_ACTIONS = {
    "captured",
    "advanced",
    "retired",
    "error_ignored",
    "invalid_token",
    "ambiguous_calls",
    "stale_generation",
    "observed",
    "ineligible",
    "unknown_attempt",
}
TRACE_PHASES = {"request", "response", "attempt_aborted"}


@dataclass
class Sample:
    request: dict[str, Any]
    response: dict[str, Any] | None
    attempts: list[dict[str, Any]]
    provenance: dict[str, Any]
    logical_timestamp: datetime | None
    turn: str = "unknown"
    gap_band: str = "unknown"
    previous: Sample | None = None


def parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def load_records(
    paths: list[Path],
    *,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_rows_per_file: int = DEFAULT_MAX_ROWS_PER_FILE,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Load explicit date-scoped JSONL traces and safe file metadata."""
    records: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    resolved_paths: set[Path] = set()
    for path in paths:
        match = TRACE_NAME.fullmatch(path.name)
        if not match:
            raise ValueError(f"trace path is not explicitly date-scoped: {path}")
        resolved = path.resolve()
        if resolved in resolved_paths:
            raise ValueError(f"duplicate trace path after resolution: {path.name}")
        resolved_paths.add(resolved)
        file_bytes = path.stat().st_size
        if file_bytes > max_file_bytes:
            raise ValueError(
                f"{path.name}: byte limit exceeded ({file_bytes} > {max_file_bytes})"
            )
        expected_date = date.fromisoformat(match.group(1))
        rows: list[dict[str, Any]] = []
        excluded: Counter[str] = Counter()
        source_rows = 0
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                source_rows = line_number
                if line_number > max_rows_per_file:
                    raise ValueError(
                        f"{path.name}: row limit exceeded "
                        f"({line_number} > {max_rows_per_file})"
                    )
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"{path.name}:{line_number}: {error}") from error
                if not isinstance(value, dict):
                    raise TypeError(
                        f"{path.name}:{line_number}: expected one JSON object"
                    )
                phase = value.get("phase")
                timestamp = parse_ts(value.get("ts"))
                if phase in TRACE_PHASES and timestamp is None:
                    raise ValueError(
                        f"{path.name}:{line_number}: {phase} record requires a "
                        "valid timestamp"
                    )
                if (
                    timestamp is not None
                    and timestamp.astimezone(timezone.utc).date() != expected_date
                ):
                    raise ValueError(
                        f"{path.name}:{line_number}: timestamp UTC date does not "
                        "match filename date"
                    )
                exclusion_reason = trace_exclusion_reason(value)
                if exclusion_reason is not None:
                    excluded[exclusion_reason] += 1
                    continue
                rows.append(value)
        timestamps = [parse_ts(row.get("ts")) for row in rows]
        present = [value for value in timestamps if value is not None]
        files.append(
            {
                "date_scope": match.group(1),
                "path_basename": path.name,
                "bytes": file_bytes,
                "rows": source_rows,
                "accepted_rows": len(rows),
                "excluded_rows": sum(excluded.values()),
                "excluded_rows_by_reason": dict(sorted(excluded.items())),
                "min_ts": min(present).isoformat() if present else None,
                "max_ts": max(present).isoformat() if present else None,
            }
        )
        records.extend(rows)
    return records, files


def trace_exclusion_reason(row: dict[str, Any]) -> str | None:
    """Fail closed on schemas or phases this issue-specific analyzer cannot know."""
    if "trace_schema_version" not in row:
        return "missing_schema"
    version = row.get("trace_schema_version")
    if isinstance(version, bool) or not isinstance(version, int):
        return "malformed_schema"
    if version < MIN_SUPPORTED_SCHEMA:
        return "unsupported_legacy_schema"
    if version > MAX_SUPPORTED_SCHEMA:
        return "future_schema"
    if row.get("phase") not in TRACE_PHASES:
        return "unknown_phase"
    return None


def without_aborted_attempts(
    records: Iterable[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int]:
    rows = list(records)
    aborted = {
        row["attempt_id"]
        for row in rows
        if row.get("phase") == "attempt_aborted"
        and isinstance(row.get("attempt_id"), str)
        and row["attempt_id"]
    }
    filtered = [
        row
        for row in rows
        if row.get("phase") != "attempt_aborted"
        and not (
            isinstance(row.get("attempt_id"), str) and row.get("attempt_id") in aborted
        )
    ]
    return filtered, len(aborted)


def is_legacy_join_eligible(row: dict[str, Any]) -> bool:
    version = row.get("trace_schema_version")
    return (
        isinstance(version, int)
        and not isinstance(version, bool)
        and MIN_SUPPORTED_SCHEMA <= version <= LEGACY_JOIN_MAX_SCHEMA
    )


def append_index(
    index: dict[str, list[dict[str, Any]]], key: Any, row: dict[str, Any]
) -> None:
    if isinstance(key, str) and key:
        index[key].append(row)


def build_indexes(
    records: Iterable[dict[str, Any]],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    indexes: dict[str, dict[str, list[dict[str, Any]]]] = {
        "request_attempt": defaultdict(list),
        "response_attempt": defaultdict(list),
        "request_legacy": defaultdict(list),
        "response_legacy": defaultdict(list),
    }
    for row in records:
        phase = row.get("phase")
        if phase not in {"request", "response"}:
            continue
        kind = "request" if phase == "request" else "response"
        attempt_id = row.get("attempt_id")
        if isinstance(attempt_id, str) and attempt_id:
            append_index(indexes[f"{kind}_attempt"], attempt_id, row)
        elif is_legacy_join_eligible(row):
            append_index(indexes[f"{kind}_legacy"], row.get("request_id"), row)
    return indexes


def logical_ids_match(request: dict[str, Any], response: dict[str, Any]) -> bool:
    request_id = request.get("request_id")
    response_id = response.get("request_id")
    return not (
        isinstance(request_id, str)
        and request_id
        and isinstance(response_id, str)
        and response_id
        and request_id != response_id
    )


def join_response(
    request: dict[str, Any], indexes: dict[str, dict[str, list[dict[str, Any]]]]
) -> dict[str, Any] | None:
    """Return only an unambiguous, schema-correct request/response join."""
    attempt_id = request.get("attempt_id")
    if isinstance(attempt_id, str) and attempt_id:
        requests = indexes["request_attempt"].get(attempt_id, [])
        responses = indexes["response_attempt"].get(attempt_id, [])
        if len(requests) == 1 and len(responses) == 1:
            response = responses[0]
            return response if logical_ids_match(request, response) else None
        return None
    if not is_legacy_join_eligible(request):
        return None
    request_id = request.get("request_id")
    if isinstance(request_id, str) and request_id:
        requests = indexes["request_legacy"].get(request_id, [])
        responses = indexes["response_legacy"].get(request_id, [])
        if len(requests) == 1 and len(responses) == 1:
            response = responses[0]
            return response if logical_ids_match(request, response) else None
    return None


def request_sort_key(row: dict[str, Any]) -> tuple[int, float]:
    ordinal = row.get("attempt_ordinal")
    ordinal_value = (
        ordinal if isinstance(ordinal, int) and not isinstance(ordinal, bool) else 0
    )
    timestamp = parse_ts(row.get("ts"))
    return ordinal_value, timestamp.timestamp() if timestamp else math.inf


def earliest_timestamp(rows: Iterable[dict[str, Any]]) -> datetime | None:
    timestamps = [parse_ts(row.get("ts")) for row in rows]
    present = [value for value in timestamps if value is not None]
    return min(present) if present else None


def annotate_turns(samples: list[Sample]) -> None:
    groups: dict[str, list[Sample]] = defaultdict(list)
    for sample in samples:
        cohort = sample.request.get("codex_turn_state_cohort_id")
        if (
            isinstance(cohort, str)
            and SAFE_COHORT.fullmatch(cohort)
            and sample.logical_timestamp is not None
        ):
            groups[cohort.lower()].append(sample)
    for group in groups.values():
        group.sort(
            key=lambda sample: (
                sample.logical_timestamp or datetime.max.replace(tzinfo=LOCAL_TZ)
            )
        )
        for index, sample in enumerate(group):
            if index == 0:
                sample.turn = "first_observed"
                continue
            previous = group[index - 1]
            sample.previous = previous
            sample.turn = "follow_up_observed"
            if (
                sample.logical_timestamp is None
                or previous.logical_timestamp is None
                or sample.logical_timestamp < previous.logical_timestamp
            ):
                continue
            gap_seconds = (
                sample.logical_timestamp - previous.logical_timestamp
            ).total_seconds()
            if gap_seconds < 60:
                sample.gap_band = "under_1m"
            elif gap_seconds < 300:
                sample.gap_band = "from_1m_to_5m"
            elif gap_seconds < 900:
                sample.gap_band = "from_5m_to_15m"
            elif gap_seconds < 3600:
                sample.gap_band = "from_15m_to_60m"
            else:
                sample.gap_band = "at_least_60m"


def make_samples(records: list[dict[str, Any]], logical: bool) -> list[Sample]:
    """Build physical or final-observed logical samples after abort filtering."""
    filtered, _ = without_aborted_attempts(records)
    indexes = build_indexes(filtered)
    requests = [row for row in filtered if row.get("phase") == "request"]
    if not logical:
        samples = [
            Sample(
                request=row,
                response=join_response(row, indexes),
                attempts=[row],
                provenance=row,
                logical_timestamp=parse_ts(row.get("ts")),
            )
            for row in requests
        ]
        annotate_turns(samples)
        return samples

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    anonymous = 0
    for row in requests:
        if isinstance(row.get("request_id"), str) and row["request_id"]:
            key = f"logical:{row['request_id']}"
        elif isinstance(row.get("attempt_id"), str) and row["attempt_id"]:
            key = f"attempt:{row['attempt_id']}"
        else:
            key = f"anonymous:{anonymous}"
            anonymous += 1
        groups[key].append(row)

    samples: list[Sample] = []
    for attempts in groups.values():
        ordered = sorted(attempts, key=request_sort_key)
        final_request = ordered[-1]
        samples.append(
            Sample(
                request=final_request,
                response=join_response(final_request, indexes),
                attempts=ordered,
                provenance=ordered[0],
                logical_timestamp=earliest_timestamp(ordered),
            )
        )
    annotate_turns(samples)
    return samples


def safe_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return float(value)


def cache_measurement(
    sample: Sample,
) -> (
    tuple[
        float,
        float,
        float,
        float | None,
        float | None,
        float | None,
    ]
    | None
):
    response = sample.response
    if response is None or response.get("cache_measurement_available") is False:
        return None
    total_input = safe_number(response.get("input_tokens"))
    cache_read = safe_number(response.get("cache_read_input_tokens"))
    cache_creation = safe_number(response.get("cache_creation_input_tokens"))
    if total_input is None or cache_read is None:
        return None
    if total_input <= 0 or cache_read > total_input:
        return None
    component_breakdown_available = (
        cache_creation is not None and cache_creation <= total_input - cache_read
    )
    uncached_input = (
        total_input - cache_read - cache_creation
        if component_breakdown_available and cache_creation is not None
        else None
    )
    legacy_share = (
        cache_read / (total_input + cache_read + cache_creation)
        if component_breakdown_available and cache_creation is not None
        else None
    )
    return (
        total_input,
        cache_read,
        cache_read / total_input,
        uncached_input,
        cache_creation if component_breakdown_available else None,
        legacy_share,
    )


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def safe_model(row: dict[str, Any]) -> str:
    model = row.get("model_out") or row.get("model_in")
    if not isinstance(model, str) or not model:
        return "unknown"
    patterns = (
        (r"^gpt-5\.6-sol(?:-\d{4}-\d{2}-\d{2})?$", "gpt-5.6-sol"),
        (r"^gpt-5\.6-terra(?:-\d{4}-\d{2}-\d{2})?$", "gpt-5.6-terra"),
        (r"^gpt-5\.6-luna(?:-\d{4}-\d{2}-\d{2})?$", "gpt-5.6-luna"),
        (r"^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$", "gpt-5.5"),
        (r"^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$", "gpt-5.4-mini"),
        (r"^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$", "gpt-5.4"),
        (r"^gpt-5\.3-codex(?:-\d{4}-\d{2}-\d{2})?$", "gpt-5.3-codex"),
    )
    for pattern, family in patterns:
        if re.fullmatch(pattern, model):
            return family
    return "other_or_custom"


def safe_category(value: Any, allowlist: set[str]) -> str:
    if value is None or value == "":
        return "unavailable"
    return value if isinstance(value, str) and value in allowlist else "unknown"


def safe_schema_version(value: Any) -> int | str:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return "invalid"


def safe_arm(row: dict[str, Any]) -> str:
    return safe_category(row.get("codex_turn_state_arm"), TURN_STATE_ARMS)


def safe_action(row: dict[str, Any]) -> str:
    return safe_category(
        row.get("codex_turn_state_request_action"), TURN_STATE_REQUEST_ACTIONS
    )


def rounded(value: float | None, digits: int = 1) -> float | None:
    if value is None:
        return None
    scale = 10**digits
    return math.floor(value * scale + 0.5) / scale


def numeric_median(samples: list[Sample], field: str) -> float | None:
    values = [safe_number(sample.request.get(field)) for sample in samples]
    present = [value for value in values if value is not None]
    return statistics.median(present) if present else None


def sample_hour(sample: Sample) -> str | None:
    if sample.logical_timestamp is None:
        return None
    return f"{sample.logical_timestamp.astimezone(LOCAL_TZ).hour:02d}"


def cohort_set(samples: Iterable[Sample]) -> set[str]:
    return {
        cohort.lower()
        for sample in samples
        if isinstance(cohort := sample.request.get("codex_turn_state_cohort_id"), str)
        and SAFE_COHORT.fullmatch(cohort)
    }


def summarize(samples: list[Sample]) -> dict[str, Any]:
    measurements = [cache_measurement(sample) for sample in samples]
    measured = [value for value in measurements if value is not None]
    shares = [value[2] for value in measured]
    component_measured = [
        value
        for value in measured
        if value[3] is not None and value[4] is not None and value[5] is not None
    ]
    legacy_shares = [value[5] for value in component_measured]
    input_sum = sum(value[0] for value in measured)
    read_sum = sum(value[1] for value in measured)
    component_input_sum = sum(value[0] for value in component_measured)
    component_read_sum = sum(value[1] for value in component_measured)
    uncached_sum = sum(value[3] for value in component_measured)
    creation_sum = sum(value[4] for value in component_measured)
    model_counts = Counter(safe_model(sample.request) for sample in samples)
    turn_counts = Counter(sample.turn for sample in samples)
    gap_counts = Counter(sample.gap_band for sample in samples)
    hour_counts = Counter(
        hour for sample in samples if (hour := sample_hour(sample)) is not None
    )
    hmac_counts: Counter[str] = Counter()
    terminal_counts: Counter[str] = Counter()
    for sample in samples:
        response = sample.response
        if response is None:
            continue
        request_hmac = sample.request.get("codex_turn_state_request_hmac")
        response_hmac = response.get("codex_turn_state_hmac")
        if (
            isinstance(request_hmac, str)
            and request_hmac
            and isinstance(response_hmac, str)
            and response_hmac
        ):
            hmac_counts[
                "matched" if request_hmac == response_hmac else "mismatched"
            ] += 1
        else:
            hmac_counts["unavailable"] += 1
        terminal_counts[
            safe_category(
                response.get("codex_turn_state_terminal_action"),
                TURN_STATE_TERMINAL_ACTIONS,
            )
        ] += 1
    return {
        "requests": len(samples),
        "physical_attempts": sum(len(sample.attempts) for sample in samples),
        "joined_responses": sum(sample.response is not None for sample in samples),
        "measured_responses": len(measured),
        "semantic_cache_measured_responses": len(measured),
        "semantic_cache_unavailable_responses": sum(
            sample.response is not None for sample in samples
        )
        - len(measured),
        "component_breakdown_measured_responses": len(component_measured),
        "component_breakdown_unavailable_responses": sum(
            sample.response is not None for sample in samples
        )
        - len(component_measured),
        "legacy_double_count_measured_responses": len(component_measured),
        "trace_total_input_tokens": int(input_sum),
        "uncached_input_tokens": (int(uncached_sum) if component_measured else None),
        "cache_read_input_tokens": int(read_sum),
        "cache_creation_input_tokens": (
            int(creation_sum) if component_measured else None
        ),
        "cache_read_share_token_weighted_pct": rounded(
            100 * read_sum / input_sum if input_sum else None
        ),
        "cache_read_share_median_pct": rounded(
            100 * statistics.median(shares) if shares else None
        ),
        "legacy_double_count_share_token_weighted_pct": rounded(
            100
            * component_read_sum
            / (component_input_sum + component_read_sum + creation_sum)
            if component_input_sum + component_read_sum + creation_sum
            else None
        ),
        "legacy_double_count_share_median_pct": rounded(
            100 * statistics.median(legacy_shares) if legacy_shares else None
        ),
        "cache_read_share_p25_pct": rounded(
            100 * percentile(shares, 0.25) if shares else None
        ),
        "cache_read_share_p75_pct": rounded(
            100 * percentile(shares, 0.75) if shares else None
        ),
        "positive_hit_rate_pct": rounded(
            100 * sum(value[1] > 0 for value in measured) / len(measured)
            if measured
            else None
        ),
        "zero_hit_rate_pct": rounded(
            100 * sum(value[1] == 0 for value in measured) / len(measured)
            if measured
            else None
        ),
        "median_trace_total_input_tokens": rounded(
            statistics.median(value[0] for value in measured) if measured else None,
            0,
        ),
        "median_message_count": rounded(numeric_median(samples, "message_count"), 1),
        "median_input_item_count": rounded(
            numeric_median(samples, "input_item_total_count"), 1
        ),
        "models": dict(sorted(model_counts.items())),
        "turns": dict(sorted(turn_counts.items())),
        "gap_bands": dict(sorted(gap_counts.items())),
        "local_hour_et": dict(sorted(hour_counts.items())),
        "distinct_cohorts": len(cohort_set(samples)),
        "turn_state_hmac": dict(sorted(hmac_counts.items())),
        "terminal_actions": dict(sorted(terminal_counts.items())),
    }


def select(
    samples: list[Sample],
    *,
    arm: str | None = None,
    action: str | None = None,
    model: str | None = None,
    turn: str | None = None,
    replay_applied: bool | None = None,
    basis: str = "response_attempt",
    require_response: bool = False,
) -> list[Sample]:
    selected: list[Sample] = []
    for sample in samples:
        row = sample.provenance if basis == "first_attempt" else sample.request
        if require_response and sample.response is None:
            continue
        if arm is not None and safe_arm(row) != arm:
            continue
        if action is not None and safe_action(row) != action:
            continue
        if model is not None and safe_model(row) != model:
            continue
        if turn is not None and sample.turn != turn:
            continue
        if (
            replay_applied is not None
            and (row.get("codex_turn_state_replay_applied") is True) != replay_applied
        ):
            continue
        selected.append(sample)
    return selected


def previous_prefix_status(sample: Sample) -> str:
    previous = sample.previous
    if previous is None:
        return "no_prior_in_date_slice"
    previous_request = previous.request
    current = sample.request
    previous_count = previous_request.get(
        "input_item_total_count", previous_request.get("input_item_count")
    )
    current_count = current.get(
        "input_item_total_count", current.get("input_item_count")
    )
    current_fingerprints = current.get("input_item_fingerprints")
    previous_fingerprints = previous_request.get("input_item_fingerprints")
    if (
        isinstance(previous_count, bool)
        or not isinstance(previous_count, int)
        or not isinstance(current_fingerprints, list)
        or not isinstance(previous_fingerprints, list)
    ):
        return "unavailable_absent_fingerprints"
    boundary_index = previous_count - 1
    previous_final = next(
        (
            item
            for item in previous_fingerprints
            if isinstance(item, dict) and item.get("index") == boundary_index
        ),
        None,
    )
    if not isinstance(previous_final, dict):
        return "unavailable_absent_fingerprints"
    if (
        isinstance(current_count, int)
        and not isinstance(current_count, bool)
        and current_count < previous_count
    ):
        return "changed"
    current_boundary = next(
        (
            item
            for item in current_fingerprints
            if isinstance(item, dict) and item.get("index") == boundary_index
        ),
        None,
    )
    if not isinstance(current_boundary, dict):
        retained_indexes = [
            item.get("index")
            for item in current_fingerprints
            if isinstance(item, dict)
            and isinstance(item.get("index"), int)
            and not isinstance(item.get("index"), bool)
        ]
        if (
            current.get("input_item_fingerprints_truncated") is True
            and retained_indexes
            and min(retained_indexes) > boundary_index
        ):
            return "unavailable_retention_window"
        return "changed"
    previous_hmac = previous_final.get("hmac")
    current_hmac = current_boundary.get("hmac")
    if not (
        isinstance(previous_hmac, str)
        and previous_hmac
        and isinstance(current_hmac, str)
        and current_hmac
    ):
        return "unavailable_absent_fingerprints"
    return (
        "retained_exact_prior_full_prefix"
        if previous_hmac == current_hmac
        else "changed"
    )


def stability(sample: Sample, field: str) -> str:
    if sample.previous is None:
        return "no_prior_in_date_slice"
    previous_value = sample.previous.request.get(field)
    current_value = sample.request.get(field)
    if (
        not isinstance(previous_value, str)
        or not previous_value
        or not isinstance(current_value, str)
        or not current_value
    ):
        return "unavailable"
    return "stable" if previous_value == current_value else "changed"


def transition_summary(samples: list[Sample]) -> dict[str, Any]:
    return {
        "requests": len(samples),
        "prefix": dict(
            sorted(
                Counter(previous_prefix_status(sample) for sample in samples).items()
            )
        ),
        "instructions": dict(
            sorted(
                Counter(
                    stability(sample, "instructions_hmac") for sample in samples
                ).items()
            )
        ),
        "tools": dict(
            sorted(
                Counter(stability(sample, "tools_hmac") for sample in samples).items()
            )
        ),
        "prompt_cache_key": dict(
            sorted(
                Counter(
                    stability(sample, "prompt_cache_key_id") for sample in samples
                ).items()
            )
        ),
    }


def transition_cache_summary(samples: list[Sample]) -> dict[str, Any]:
    groups: dict[str, list[Sample]] = defaultdict(list)
    for sample in samples:
        groups[previous_prefix_status(sample)].append(sample)
    return {key: summarize(group) for key, group in sorted(groups.items())}


def skill_signature(samples: list[Sample]) -> dict[str, Any]:
    def skill_count(sample: Sample, field: str) -> int:
        value = sample.request.get(field)
        if not isinstance(value, dict):
            return 0
        count = value.get("Skill", 0)
        return count if isinstance(count, int) and not isinstance(count, bool) else 0

    return {
        "requests": len(samples),
        "with_new_skill_call": sum(
            skill_count(sample, "new_tool_use_by_name") > 0 for sample in samples
        ),
        "with_historical_skill_call": sum(
            skill_count(sample, "history_tool_use_by_name") > 0 for sample in samples
        ),
        "with_any_skill_call": sum(
            skill_count(sample, "new_tool_use_by_name") > 0
            or skill_count(sample, "history_tool_use_by_name") > 0
            for sample in samples
        ),
        "with_continuation_nudge": sum(
            (safe_number(sample.request.get("nudge_count")) or 0) > 0
            for sample in samples
        ),
        "nudge_count_total": int(
            sum(
                safe_number(sample.request.get("nudge_count")) or 0
                for sample in samples
            )
        ),
        "median_new_tool_calls": rounded(
            numeric_median(samples, "new_tool_call_count"), 1
        ),
        "median_history_tool_outputs": rounded(
            numeric_median(samples, "history_function_call_output_count"), 1
        ),
    }


def final_input_fingerprint_profile(samples: list[Sample]) -> dict[str, Any]:
    """Summarize cumulative HMACs for each request's complete converted input.

    Each ``input_item_fingerprints[].hmac`` is a prefix-chain HMAC. The last
    entry therefore identifies the full converted input, not the final item in
    isolation. Only aggregate counts are emitted; the HMAC values stay private.
    """
    fingerprints: list[str] = []
    unavailable = 0
    for sample in samples:
        items = sample.request.get("input_item_fingerprints")
        last = items[-1] if isinstance(items, list) and items else None
        hmac = last.get("hmac") if isinstance(last, dict) else None
        if isinstance(hmac, str) and hmac:
            fingerprints.append(hmac)
        else:
            unavailable += 1
    counts = Counter(fingerprints)
    return {
        "requests": len(samples),
        "available": len(fingerprints),
        "unavailable": unavailable,
        "distinct_final_full_input_fingerprints": len(counts),
        "largest_repeated_full_input_fingerprint_cluster": max(
            counts.values(), default=0
        ),
    }


def appended_spillover(samples: list[Sample]) -> dict[str, Any]:
    """Find the next distinct logical request strictly after a tool response."""
    groups: dict[str, list[Sample]] = defaultdict(list)
    for sample in samples:
        cohort = sample.request.get("codex_turn_state_cohort_id")
        if isinstance(cohort, str) and SAFE_COHORT.fullmatch(cohort):
            groups[cohort.lower()].append(sample)
    next_actions: Counter[str] = Counter()
    tool_use_responses = 0
    ambiguous_chronology = 0
    missing_chronology = 0
    for group in groups.values():
        for sample in group:
            if (
                safe_action(sample.request) != "appended_input_suppressed"
                or sample.response is None
                or sample.response.get("stop_reason") != "tool_use"
            ):
                continue
            tool_use_responses += 1
            response_timestamp = parse_ts(sample.response.get("ts"))
            candidates = [candidate for candidate in group if candidate is not sample]
            if response_timestamp is None or any(
                candidate.logical_timestamp is None for candidate in candidates
            ):
                missing_chronology += 1
                continue
            later = [
                candidate
                for candidate in candidates
                if candidate.logical_timestamp is not None
                and candidate.logical_timestamp > response_timestamp
            ]
            if not later:
                next_actions["no_later_request_in_slice"] += 1
                continue
            first_timestamp = min(
                candidate.logical_timestamp
                for candidate in later
                if candidate.logical_timestamp is not None
            )
            first = [
                candidate
                for candidate in later
                if candidate.logical_timestamp == first_timestamp
            ]
            if len(first) != 1:
                ambiguous_chronology += 1
                continue
            next_actions[safe_action(first[0].request)] += 1
    return {
        "appended_tool_use_responses": tool_use_responses,
        "immediate_next_action": dict(sorted(next_actions.items())),
        "ambiguous_chronology": ambiguous_chronology,
        "missing_chronology": missing_chronology,
    }


def grouped_summary(samples: list[Sample], field: str) -> dict[str, Any]:
    groups: dict[str, list[Sample]] = defaultdict(list)
    for sample in samples:
        if field == "model":
            key = safe_model(sample.request)
        elif field == "turn":
            key = sample.turn
        elif field == "action":
            key = safe_action(sample.request)
        elif field == "arm":
            key = safe_arm(sample.request)
        elif field == "hour":
            key = sample_hour(sample) or "unavailable"
        else:
            raise ValueError(field)
        groups[key].append(sample)
    return {key: summarize(group) for key, group in sorted(groups.items())}


def confound_comparison(left: list[Sample], right: list[Sample]) -> dict[str, Any]:
    left_cohorts = cohort_set(left)
    right_cohorts = cohort_set(right)
    return {
        "left": summarize(left),
        "right": summarize(right),
        "cohort_overlap_count": len(left_cohorts & right_cohorts),
        "cohort_union_count": len(left_cohorts | right_cohorts),
        "note": (
            "Model, turn, conversation-length, local-hour, and cohort composition "
            "are descriptive confound checks, not causal adjustments."
        ),
    }


def crossover_summary(samples: list[Sample]) -> dict[str, Any]:
    """Describe retry drift without leaking logical or physical identifiers."""
    arm_crossovers = 0
    action_crossovers = 0
    q1_action_crossovers = 0
    q1_paths: Counter[str] = Counter()
    for sample in samples:
        first_arm = safe_arm(sample.provenance)
        final_arm = safe_arm(sample.request)
        first_action = safe_action(sample.provenance)
        final_action = safe_action(sample.request)
        if first_arm != final_arm:
            arm_crossovers += 1
        if first_action != final_action:
            action_crossovers += 1
        if first_action != final_action and {first_action, final_action} & {
            "replay",
            "would_replay",
        }:
            q1_action_crossovers += 1
            q1_paths[f"{first_action} -> {final_action}"] += 1
    return {
        "logical_requests": len(samples),
        "multiple_attempt_logical_requests": sum(
            len(sample.attempts) > 1 for sample in samples
        ),
        "arm_crossovers": arm_crossovers,
        "action_crossovers": action_crossovers,
        "q1_action_crossovers": q1_action_crossovers,
        "q1_action_paths": dict(sorted(q1_paths.items())),
    }


def data_quality(
    all_records: list[dict[str, Any]],
    filtered_records: list[dict[str, Any]],
    aborted_count: int,
    physical_samples: list[Sample],
    logical_samples: list[Sample],
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    phase_counts = Counter(
        safe_category(row.get("phase", "request"), TRACE_PHASES) for row in all_records
    )
    schemas = sorted(
        {safe_schema_version(row.get("trace_schema_version")) for row in all_records},
        key=str,
    )
    indexes = build_indexes(filtered_records)
    logical_request_attempts = Counter(
        row.get("request_id")
        for row in filtered_records
        if row.get("phase", "request") == "request" and row.get("request_id")
    )
    response_only_attempts = sum(
        key not in indexes["request_attempt"] for key in indexes["response_attempt"]
    )
    schema9_missing_attempt_ids = sum(
        row.get("phase", "request") in {"request", "response"}
        and not row.get("attempt_id")
        and not is_legacy_join_eligible(row)
        for row in filtered_records
    )
    return {
        "source_rows": sum(
            file.get("rows", 0) for file in files if isinstance(file.get("rows"), int)
        )
        if files
        else len(all_records),
        "schema_rows_accepted": len(all_records),
        "schema_rows_excluded": sum(
            file.get("excluded_rows", 0)
            for file in files
            if isinstance(file.get("excluded_rows"), int)
        ),
        "schema_rows_excluded_by_reason": dict(
            sorted(
                sum(
                    (
                        Counter(file.get("excluded_rows_by_reason", {}))
                        for file in files
                    ),
                    Counter(),
                ).items()
            )
        ),
        "input_rows": len(all_records),
        "rows_after_aborted_filter": len(filtered_records),
        "phases": dict(sorted(phase_counts.items())),
        "trace_schema_versions": schemas,
        "aborted_attempt_ids_excluded": aborted_count,
        "physical_request_records": len(physical_samples),
        "final_observed_logical_requests": len(logical_samples),
        "physical_joined": sum(
            sample.response is not None for sample in physical_samples
        ),
        "logical_joined": sum(
            sample.response is not None for sample in logical_samples
        ),
        "duplicate_request_attempt_id_groups": sum(
            len(rows) != 1 for rows in indexes["request_attempt"].values()
        ),
        "duplicate_response_attempt_id_groups": sum(
            len(rows) != 1 for rows in indexes["response_attempt"].values()
        ),
        "response_only_attempt_ids": response_only_attempts,
        "schema9_plus_records_missing_attempt_id": schema9_missing_attempt_ids,
        "logical_request_ids_with_multiple_attempts": sum(
            count > 1 for count in logical_request_attempts.values()
        ),
    }


def open_read_only_database(path: Path) -> sqlite3.Connection:
    """Open SQLite with two independent, enforced read-only controls."""
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only = ON")
        state = connection.execute("PRAGMA query_only").fetchone()
        if state is None or state[0] != 1:
            raise sqlite3.OperationalError("SQLite query_only mode did not activate")
    except BaseException:
        connection.close()
        raise
    return connection


def read_database_rows(path: Path, request_ids: list[str]) -> dict[str, sqlite3.Row]:
    connection = open_read_only_database(path)
    try:
        rows: dict[str, sqlite3.Row] = {}
        for offset in range(0, len(request_ids), 500):
            chunk = request_ids[offset : offset + 500]
            placeholders = ",".join("?" for _ in chunk)
            query = f"""
                SELECT id, prompt_tokens, input_tokens,
                       cache_read_input_tokens, cache_creation_input_tokens,
                       client_session_id
                FROM requests
                WHERE id IN ({placeholders})
            """
            for row in connection.execute(query, chunk):
                rows[str(row["id"])] = row
        return rows
    finally:
        connection.close()


def database_validation(samples: list[Sample], path: Path) -> dict[str, Any]:
    request_ids = sorted(
        {
            sample.request["request_id"]
            for sample in samples
            if isinstance(sample.request.get("request_id"), str)
            and sample.request["request_id"]
        }
    )
    database_rows = read_database_rows(path, request_ids)
    comparisons: Counter[str] = Counter()
    sessions_by_group: dict[str, set[str]] = defaultdict(set)
    missing_sessions: Counter[str] = Counter()
    for sample in samples:
        request_id = sample.request.get("request_id")
        if not isinstance(request_id, str):
            continue
        row = database_rows.get(request_id)
        if row is None:
            comparisons["missing_database_row"] += 1
            continue
        comparisons["matched_database_row"] += 1
        groups = [
            "all",
            f"action:{safe_action(sample.request)}",
            f"arm:{safe_arm(sample.request)}",
        ]
        session_id = row["client_session_id"]
        for group in groups:
            if isinstance(session_id, str) and session_id:
                sessions_by_group[group].add(session_id)
            else:
                missing_sessions[group] += 1
        response = sample.response
        if response is None:
            continue
        trace_total = safe_number(response.get("input_tokens"))
        trace_read = safe_number(response.get("cache_read_input_tokens"))
        trace_creation = safe_number(response.get("cache_creation_input_tokens"))
        db_prompt = safe_number(row["prompt_tokens"])
        db_uncached = safe_number(row["input_tokens"])
        db_read = safe_number(row["cache_read_input_tokens"])
        db_creation = safe_number(row["cache_creation_input_tokens"])
        semantic_values = (trace_total, trace_read, db_prompt, db_read)
        if any(value is None for value in semantic_values):
            comparisons["semantic_measurement_unavailable"] += 1
            continue
        comparisons["semantic_measurement_compared"] += 1
        if trace_total == db_prompt:
            comparisons["trace_total_equals_db_prompt"] += 1
        if trace_read == db_read:
            comparisons["trace_cache_read_equals_db"] += 1
        if (
            trace_total > 0
            and db_prompt > 0
            and abs(trace_read / trace_total - db_read / db_prompt) < 1e-12
        ):
            comparisons["semantic_cache_share_matches"] += 1
        component_values = (trace_creation, db_uncached, db_creation)
        if any(value is None for value in component_values):
            comparisons["component_breakdown_unavailable"] += 1
            continue
        comparisons["component_breakdown_compared"] += 1
        if db_uncached + db_read + db_creation == db_prompt:
            comparisons["db_additive_components_equal_prompt"] += 1
        if trace_creation == db_creation:
            comparisons["trace_cache_creation_equals_db"] += 1
    return {
        "database_open_mode": "mode=ro+query_only",
        "logical_request_ids_queried": len(request_ids),
        "database_rows_found": len(database_rows),
        "comparisons": dict(sorted(comparisons.items())),
        "distinct_sessions": {
            group: len(sessions)
            for group, sessions in sorted(sessions_by_group.items())
        },
        "missing_session_ids": dict(sorted(missing_sessions.items())),
        "field_semantics": {
            "trace_input_tokens": "cache_inclusive_total",
            "database_prompt_tokens": "cache_inclusive_total",
            "database_input_tokens": "additive_uncached_bucket",
            "database_cache_read_input_tokens": "additive_cache_read_bucket",
            "database_cache_creation_input_tokens": "additive_cache_write_bucket",
        },
    }


def build_report(
    records: list[dict[str, Any]], files: list[dict[str, Any]]
) -> dict[str, Any]:
    filtered, aborted_count = without_aborted_attempts(records)
    physical = make_samples(filtered, logical=False)
    logical = make_samples(filtered, logical=True)

    replay = select(
        logical,
        arm="treatment",
        action="replay",
        replay_applied=True,
        require_response=True,
    )
    replay_applied = select(
        logical,
        arm="treatment",
        action="replay",
        replay_applied=True,
        require_response=True,
    )
    would_replay = select(
        logical,
        arm="control",
        action="would_replay",
        require_response=True,
    )
    itt_replay = select(
        logical,
        arm="treatment",
        action="replay",
        basis="first_attempt",
    )
    itt_would_replay = select(
        logical,
        arm="control",
        action="would_replay",
        basis="first_attempt",
    )
    no_pending = select(logical, arm="treatment", action="no_pending")
    new_turn = select(logical, arm="treatment", action="new_turn")
    appended = select(logical, action="appended_input_suppressed")
    appended_physical = select(physical, action="appended_input_suppressed")
    eligible = [
        sample
        for sample in logical
        if safe_arm(sample.request) in {"treatment", "control"}
    ]
    eligible_followups = [
        sample for sample in eligible if sample.turn == "follow_up_observed"
    ]
    appended_followups = [
        sample for sample in appended if sample.turn == "follow_up_observed"
    ]

    physical_actions = Counter(safe_action(sample.request) for sample in physical)
    physical_arms = Counter(safe_arm(sample.request) for sample in physical)
    logical_actions = Counter(safe_action(sample.request) for sample in logical)
    logical_arms = Counter(safe_arm(sample.request) for sample in logical)
    logical_itt_actions = Counter(safe_action(sample.provenance) for sample in logical)
    logical_itt_arms = Counter(safe_arm(sample.provenance) for sample in logical)

    return {
        "methodology": {
            "mechanism_unit": "final_response_bearing_non_aborted_codex_attempt",
            "experiment_intent_unit": "first_physical_attempt",
            "response_scope": "codex_trace_only_no_cross_provider_terminal_visibility",
            "supported_trace_schema_versions": {
                "minimum": MIN_SUPPORTED_SCHEMA,
                "maximum": MAX_SUPPORTED_SCHEMA,
                "legacy_request_id_join": [
                    MIN_SUPPORTED_SCHEMA,
                    LEGACY_JOIN_MAX_SCHEMA,
                ],
                "missing_schema": "excluded",
                "malformed_or_future_schema": "excluded",
            },
            "default_input_guards": {
                "max_file_bytes": DEFAULT_MAX_FILE_BYTES,
                "max_rows_per_file": DEFAULT_MAX_ROWS_PER_FILE,
            },
            "semantic_cache_share": "cache_read_input_tokens / trace_input_tokens",
            "legacy_double_count_share": (
                "cache_read_input_tokens / (trace_input_tokens + "
                "cache_read_input_tokens + cache_creation_input_tokens)"
            ),
            "median_unit": "per_measured_response_cache_share",
            "token_weighted_unit": "sum(cache_read) / sum(trace_input)",
        },
        "source_files": files,
        "data_quality": data_quality(
            records, filtered, aborted_count, physical, logical, files
        ),
        "funnel": {
            "physical_arms": dict(sorted(physical_arms.items())),
            "physical_actions": dict(sorted(physical_actions.items())),
            "logical_arms": dict(sorted(logical_arms.items())),
            "logical_actions": dict(sorted(logical_actions.items())),
            "logical_first_attempt_itt_arms": dict(sorted(logical_itt_arms.items())),
            "logical_first_attempt_itt_actions": dict(
                sorted(logical_itt_actions.items())
            ),
        },
        "q1": {
            "replay": summarize(replay),
            "replay_applied": summarize(replay_applied),
            "would_replay": summarize(would_replay),
            "itt_replay": summarize(itt_replay),
            "itt_would_replay": summarize(itt_would_replay),
            "crossovers": crossover_summary(logical),
            "treatment_no_pending": summarize(no_pending),
            "treatment_no_pending_followups": summarize(
                [sample for sample in no_pending if sample.turn == "follow_up_observed"]
            ),
            "treatment_new_turn": summarize(new_turn),
            "replay_transitions": transition_summary(replay),
            "replay_by_prefix_transition": transition_cache_summary(replay),
            "would_replay_transitions": transition_summary(would_replay),
            "replay_by_model": grouped_summary(replay, "model"),
            "would_replay_by_model": grouped_summary(would_replay, "model"),
            "replay_by_turn": grouped_summary(replay, "turn"),
            "would_replay_by_turn": grouped_summary(would_replay, "turn"),
            "replay_vs_would_replay_confounds": confound_comparison(
                replay, would_replay
            ),
        },
        "q2": {
            "appended_input_suppressed_physical": summarize(appended_physical),
            "appended_input_suppressed": summarize(appended),
            "appended_input_signature": skill_signature(appended_physical),
            "appended_final_full_input_fingerprints": final_input_fingerprint_profile(
                appended_physical
            ),
            "appended_spillover": appended_spillover(logical),
            "eligible_all": summarize(eligible),
            "appended_followups": summarize(appended_followups),
            "eligible_followups": summarize(eligible_followups),
            "appended_transitions": transition_summary(appended),
            "eligible_transitions": transition_summary(eligible),
            "eligible_followup_transitions": transition_summary(eligible_followups),
            "appended_by_model": grouped_summary(appended, "model"),
            "eligible_by_model": grouped_summary(eligible, "model"),
            "appended_by_turn": grouped_summary(appended, "turn"),
            "eligible_by_turn": grouped_summary(eligible, "turn"),
            "appended_vs_eligible_confounds": confound_comparison(appended, eligible),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Privacy-safe, read-only Codex turn-state trace analysis"
    )
    parser.add_argument(
        "trace",
        nargs="+",
        type=Path,
        help="explicit codex-trace-YYYY-MM-DD.jsonl path(s)",
    )
    parser.add_argument(
        "--database", type=Path, help="optional request-history SQLite database"
    )
    parser.add_argument(
        "--max-file-bytes",
        type=int,
        default=DEFAULT_MAX_FILE_BYTES,
        help=f"per-file safety limit (default: {DEFAULT_MAX_FILE_BYTES})",
    )
    parser.add_argument(
        "--max-rows-per-file",
        type=int,
        default=DEFAULT_MAX_ROWS_PER_FILE,
        help=f"per-file safety limit (default: {DEFAULT_MAX_ROWS_PER_FILE})",
    )
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        if args.max_file_bytes < 0 or args.max_rows_per_file < 0:
            raise ValueError("input guard limits must be non-negative integers")
        records, files = load_records(
            args.trace,
            max_file_bytes=args.max_file_bytes,
            max_rows_per_file=args.max_rows_per_file,
        )
        report = build_report(records, files)
        if args.database is not None:
            report["database_validation"] = database_validation(
                make_samples(records, logical=True), args.database
            )
    except (OSError, TypeError, ValueError, sqlite3.Error) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2 if args.pretty else None, sort_keys=True))


if __name__ == "__main__":
    main()
