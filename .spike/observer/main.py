from __future__ import annotations

import json
import math
import platform
import re
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import spacy
from dateutil import parser as date_parser
from dateutil.relativedelta import relativedelta


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent.parent
FIXTURES_PATH = REPO_ROOT / "docs" / "research" / "fixtures" / "rule-first-observer" / "dataset.json"
V1_FIXTURES_PATH = ROOT / "fixtures" / "dataset.json"
RESULTS_PATH = ROOT / "results.json"
CONFIDENCE_THRESHOLD = 0.6
NOW = datetime(2026, 4, 20, 12, 0, tzinfo=UTC)

WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}
NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}

ABSOLUTE_DATE_HINTS = re.compile(
    r"\b(?:\d{4}-\d{2}-\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|"
    r"jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|"
    r"dec(?:ember)?|\d{1,2}:\d{2}\s*(?:am|pm)|\d{1,2}\s*(?:am|pm))\b",
    re.IGNORECASE,
)
TIME_CONTEXT_HINTS = re.compile(
    r"\b(i|i'm|i am|my|me|free|appointment|interview|vacation|out|deadline|lease|"
    r"check-in|works better for me|later today)\b",
    re.IGNORECASE,
)
RELATIVE_TIME_PATTERNS = [
    re.compile(r"\bin (?P<num>\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?P<unit>days?|weeks?|months?)\b", re.IGNORECASE),
    re.compile(r"\bnext (?P<weekday>monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.IGNORECASE),
    re.compile(r"\bthis (?P<weekday>monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.IGNORECASE),
    re.compile(r"\bevery (?P<weekday>monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.IGNORECASE),
]

PREFERENCE_PATTERNS = [
    (re.compile(r"\bi prefer\b", re.IGNORECASE), 0.92),
    (re.compile(r"\bi hate\b", re.IGNORECASE), 0.92),
    (re.compile(r"\bi really like\b", re.IGNORECASE), 0.9),
    (re.compile(r"\bi avoid\b", re.IGNORECASE), 0.88),
    (re.compile(r"\bi(?:'d| would) rather\b", re.IGNORECASE), 0.9),
    (re.compile(r"\bi love\b", re.IGNORECASE), 0.9),
    (re.compile(r"\bi'm not a fan of\b", re.IGNORECASE), 0.88),
    (re.compile(r"\bi tend to\b", re.IGNORECASE), 0.72),
]

EMOTION_PATTERNS = [
    (re.compile(r"\bi(?:'m| am) feeling\b", re.IGNORECASE), 0.9),
    (re.compile(r"\bi(?:'m| am) excited\b", re.IGNORECASE), 0.88),
    (re.compile(r"\bi was pretty anxious\b", re.IGNORECASE), 0.88),
    (re.compile(r"\bi(?:'m| am) frustrated\b", re.IGNORECASE), 0.88),
    (re.compile(r"\bi feel calm\b", re.IGNORECASE), 0.84),
    (re.compile(r"\bi(?: have|'ve) been stressed\b", re.IGNORECASE), 0.88),
    (re.compile(r"\bi(?:'m| am) really happy\b", re.IGNORECASE), 0.86),
    (re.compile(r"\bi felt overwhelmed\b", re.IGNORECASE), 0.88),
    (re.compile(r"\bmaking me nervous\b", re.IGNORECASE), 0.82),
]

INTENT_PATTERNS = [
    (re.compile(r"\bi need to\b", re.IGNORECASE), 0.82),
    (re.compile(r"\bi want to\b", re.IGNORECASE), 0.78),
    (re.compile(r"\bi(?:'m| am) going to\b", re.IGNORECASE), 0.8),
    (re.compile(r"\bi'll\b", re.IGNORECASE), 0.78),
    (re.compile(r"\bi plan to\b", re.IGNORECASE), 0.8),
    (re.compile(r"\bi hope to\b", re.IGNORECASE), 0.72),
    (re.compile(r"\bi should probably\b", re.IGNORECASE), 0.58),
    (re.compile(r"\bmaybe i'll\b", re.IGNORECASE), 0.57),
    (re.compile(r"\bit would be good to\b", re.IGNORECASE), 0.54),
]

ENTITY_PATTERNS = [
    re.compile(r"\bi work (?:at|for)\b", re.IGNORECASE),
    re.compile(r"\bi work remotely for\b", re.IGNORECASE),
    re.compile(r"\bmy manager is\b", re.IGNORECASE),
    re.compile(r"\bi live in\b", re.IGNORECASE),
    re.compile(r"\bi use\b", re.IGNORECASE),
    re.compile(r"\bi(?:'m| am) from\b", re.IGNORECASE),
    re.compile(r"\bliving in\b", re.IGNORECASE),
    re.compile(r"\bmy teammate\b", re.IGNORECASE),
    re.compile(r"\bi graduated from\b", re.IGNORECASE),
    re.compile(r"\bi keep all my notes in\b", re.IGNORECASE),
]

TOOL_NAMES = {"notion", "obsidian", "linear", "figma", "bun", "npm"}
TRAP_REASONS = [
    "rhetorical_question",
    "hypothetical",
    "quoted_other",
    "generic_statement",
    "negation_of_fact",
    "past_abandoned",
    "command_or_request",
    "meta_conversation",
]


@dataclass
class Candidate:
    type: str
    confidence: float
    evidence: str
    normalized: str


@dataclass
class Prediction:
    should_extract: bool
    escalate_to_tier2: bool
    predicted_type: str | None
    confidence: float
    evidence: str
    normalized: str


class RuleFirstObserver:
    def __init__(self) -> None:
        self.nlp = spacy.load("en_core_web_sm")

    def analyze(self, text: str) -> Prediction:
        doc = self.nlp(text)
        candidates: list[Candidate] = []

        for detector in (
            self._detect_preference,
            self._detect_emotion,
            self._detect_intent,
            self._detect_time,
            self._detect_entity,
        ):
            candidate = detector(text, doc)
            if candidate is not None:
                candidates.append(candidate)

        if not candidates:
            return Prediction(False, False, None, 0.0, "", "")

        best = max(candidates, key=lambda item: item.confidence)
        if best.confidence >= CONFIDENCE_THRESHOLD:
            return Prediction(True, False, best.type, best.confidence, best.evidence, best.normalized)
        return Prediction(False, True, None, best.confidence, best.evidence, best.normalized)

    def _detect_preference(self, text: str, _doc: Any) -> Candidate | None:
        for pattern, confidence in PREFERENCE_PATTERNS:
            match = pattern.search(text)
            if match:
                return Candidate("preference", confidence, match.group(0), text.strip())
        if re.search(r"\bisn't really my thing\b", text, re.IGNORECASE):
            return Candidate("preference", 0.56, "isn't really my thing", text.strip())
        if re.search(r"\b\w+\s+over\s+\w+,\s*always\b", text, re.IGNORECASE):
            return Candidate("preference", 0.55, "implicit preference", text.strip())
        return None

    def _detect_emotion(self, text: str, _doc: Any) -> Candidate | None:
        for pattern, confidence in EMOTION_PATTERNS:
            match = pattern.search(text)
            if match:
                return Candidate("emotion", confidence, match.group(0), text.strip())
        if re.search(r"\bhas been a lot lately\b", text, re.IGNORECASE):
            return Candidate("emotion", 0.52, "implicit emotional overload", text.strip())
        return None

    def _detect_intent(self, text: str, _doc: Any) -> Candidate | None:
        for pattern, confidence in INTENT_PATTERNS:
            match = pattern.search(text)
            if match:
                return Candidate("intent", confidence, match.group(0), text.strip())
        return None

    def _detect_time(self, text: str, _doc: Any) -> Candidate | None:
        if not TIME_CONTEXT_HINTS.search(text):
            return None

        lowered = text.lower()
        if "vacation from" in lowered:
            try:
                parsed = date_parser.parse(text, fuzzy=True, default=NOW.replace(hour=9, minute=0, second=0))
            except (ValueError, OverflowError):
                parsed = NOW
            return Candidate("time", 0.84, "vacation-range", parsed.date().isoformat())
        for pattern in RELATIVE_TIME_PATTERNS:
            match = pattern.search(lowered)
            if not match:
                continue
            if "num" in match.groupdict():
                num_raw = match.group("num").lower()
                value = int(num_raw) if num_raw.isdigit() else NUMBER_WORDS[num_raw]
                unit = match.group("unit").lower()
                normalized = self._apply_delta(value, unit)
                return Candidate("time", 0.78, match.group(0), normalized)
            weekday_name = match.group("weekday").lower()
            normalized = self._resolve_weekday(weekday_name, pattern.pattern.lower().startswith(r"\bevery"))
            confidence = 0.68 if "every" in pattern.pattern else 0.74
            return Candidate("time", confidence, match.group(0), normalized)

        if "tomorrow" in lowered:
            return Candidate("time", 0.8, "tomorrow", (NOW + timedelta(days=1)).date().isoformat())
        if "tonight" in lowered:
            return Candidate("time", 0.76, "tonight", NOW.date().isoformat())
        if "next month" in lowered:
            confidence = 0.66 if "works better for me" in lowered else 0.55
            return Candidate("time", confidence, "next month", (NOW + relativedelta(months=1)).date().isoformat())

        if ABSOLUTE_DATE_HINTS.search(text):
            try:
                parsed = date_parser.parse(text, fuzzy=True, default=NOW.replace(hour=9, minute=0, second=0))
            except (ValueError, OverflowError):
                return None
            return Candidate("time", 0.86, "absolute-date", parsed.isoformat())

        return None

    def _detect_entity(self, text: str, doc: Any) -> Candidate | None:
        if re.search(r"\bstill at [A-Z][A-Za-z0-9& ]+", text, re.IGNORECASE):
            return Candidate("entity", 0.55, "implicit still-at employer", text.strip())
        if not any(pattern.search(text) for pattern in ENTITY_PATTERNS):
            return None

        named_entities = [ent.text for ent in doc.ents if ent.label_ in {"PERSON", "ORG", "GPE"}]
        if not named_entities:
            named_entities = [name for name in TOOL_NAMES if re.search(rf"\b{name}\b", text, re.IGNORECASE)]

        confidence = 0.87 if named_entities else 0.7
        normalized = "; ".join(named_entities) if named_entities else text.strip()
        evidence = named_entities[0] if named_entities else "entity-pattern"
        return Candidate("entity", confidence, evidence, normalized)

    @staticmethod
    def _apply_delta(value: int, unit: str) -> str:
        if unit.startswith("day"):
            return (NOW + timedelta(days=value)).date().isoformat()
        if unit.startswith("week"):
            return (NOW + timedelta(weeks=value)).date().isoformat()
        return (NOW + relativedelta(months=value)).date().isoformat()

    @staticmethod
    def _resolve_weekday(name: str, recurring: bool) -> str:
        delta = (WEEKDAYS[name] - NOW.weekday()) % 7
        if delta == 0 and not recurring:
            delta = 7
        target = NOW + timedelta(days=delta)
        return f"weekly:{name}" if recurring else target.date().isoformat()


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * pct
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    weight = rank - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def subset_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    positives = [row for row in rows if row["should_extract"]]
    negatives = [row for row in rows if not row["should_extract"]]
    latencies = [row["latency_ms"] for row in rows]
    true_positives = sum(1 for row in rows if row["outcome"] == "tp")
    false_negatives = sum(1 for row in rows if row["outcome"] == "fn")
    false_positives = sum(1 for row in rows if row["outcome"] == "fp")
    true_negatives = sum(1 for row in rows if row["outcome"] == "tn")
    predicted_positive = true_positives + false_positives
    escalations = sum(1 for row in rows if row["prediction"]["escalate_to_tier2"])
    precision = true_positives / predicted_positive if predicted_positive else 0.0
    recall = true_positives / len(positives) if positives else None
    f1 = (2 * precision * recall / (precision + recall)) if recall is not None and (precision + recall) else None
    false_positive_rate = false_positives / len(negatives) if negatives else None
    true_negative_rate = true_negatives / len(negatives) if negatives else None
    return {
        "support": len(rows),
        "positives": len(positives),
        "negatives": len(negatives),
        "tp": true_positives,
        "fn": false_negatives,
        "fp": false_positives,
        "tn": true_negatives,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "false_positive_rate": false_positive_rate,
        "true_negative_rate": true_negative_rate,
        "tier1_hit_rate": predicted_positive / len(rows) if rows else 0.0,
        "tier2_escalation_rate": escalations / len(rows) if rows else 0.0,
        "p50_latency_ms": percentile(latencies, 0.5) if latencies else 0.0,
        "p95_latency_ms": percentile(latencies, 0.95) if latencies else 0.0,
        "avg_latency_ms": statistics.mean(latencies) if latencies else 0.0,
    }


def distribution(fixtures: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in fixtures:
        value = item.get(key)
        if value is None:
            continue
        counts[value] = counts.get(value, 0) + 1
    return counts


def noise_distribution(fixtures: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in fixtures:
        features = item.get("noise_features") or []
        for feature in features:
            counts[feature] = counts.get(feature, 0) + 1
    return counts


def evaluate(fixtures_path: Path) -> dict[str, Any]:
    raw_fixtures = json.loads(fixtures_path.read_text())
    fixtures = []
    for item in raw_fixtures:
        fixtures.append(
            {
                "source": "legacy-self-authored",
                "source_ref": None,
                "language": "en",
                "trap_reason": None,
                "noise_features": None,
                **item,
            }
        )
    observer = RuleFirstObserver()

    rows: list[dict[str, Any]] = []
    latencies_ms: list[float] = []
    warmup_iterations = 5
    warmup_text = "I need to send the contract tonight."
    for _ in range(warmup_iterations):
        observer.analyze(warmup_text)

    for item in fixtures:
        start = time.perf_counter()
        prediction = observer.analyze(item["text"])
        latency_ms = (time.perf_counter() - start) * 1000
        latencies_ms.append(latency_ms)

        gold_positive = bool(item["should_extract"])
        predicted_positive = prediction.should_extract
        type_match = prediction.predicted_type == item["type"] if predicted_positive and gold_positive else False

        row = {
            **item,
            "prediction": asdict(prediction),
            "latency_ms": round(latency_ms, 3),
            "predicted_positive": predicted_positive,
            "type_match": type_match,
            "outcome": classify_outcome(gold_positive, predicted_positive, type_match),
        }
        rows.append(row)

    overall = subset_metrics(rows)

    per_type = {
        observation_type: subset_metrics([row for row in rows if row["type"] == observation_type])
        for observation_type in ("entity", "time", "preference", "emotion", "intent", "none")
    }
    per_difficulty = {
        difficulty: subset_metrics([row for row in rows if row["difficulty"] == difficulty])
        for difficulty in ("explicit", "implicit", "trap", "noisy")
    }
    per_language = {
        language: subset_metrics([row for row in rows if row["language"] == language])
        for language in ("en", "zh", "mixed")
    }
    per_source = {
        source: subset_metrics([row for row in rows if row["source"] == source])
        for source in sorted({row["source"] for row in rows})
    }
    per_noise_feature = {
        feature: subset_metrics([row for row in rows if feature in (row.get("noise_features") or [])])
        for feature in ("typo", "emoji", "code", "short", "long", "mixed-lang")
    }
    trap_matrix = {}
    for reason in TRAP_REASONS:
        trap_rows = [row for row in rows if row.get("trap_reason") == reason]
        trap_matrix[reason] = {
            "support": len(trap_rows),
            "mis_extracted": sum(1 for row in trap_rows if row["outcome"] == "fp"),
            "safe_rejected": sum(1 for row in trap_rows if row["outcome"] == "tn"),
            "mis_extract_rate": (
                sum(1 for row in trap_rows if row["outcome"] == "fp") / len(trap_rows)
                if trap_rows
                else None
            ),
        }

    results = {
        "environment": {
            "python": platform_python(),
            "spacy": spacy.__version__,
            "model": "en_core_web_sm",
            "fixtures_path": str(fixtures_path),
            "fixture_count": len(rows),
        },
        "dataset": {
            "type_distribution": distribution(fixtures, "type"),
            "language_distribution": distribution(fixtures, "language"),
            "difficulty_distribution": distribution(fixtures, "difficulty"),
            "source_distribution": distribution(fixtures, "source"),
            "noise_feature_distribution": noise_distribution(fixtures),
            "positive_count": sum(1 for item in fixtures if item["should_extract"]),
            "negative_count": sum(1 for item in fixtures if not item["should_extract"]),
        },
        "summary": overall,
        "per_type": per_type,
        "per_difficulty": per_difficulty,
        "per_language": per_language,
        "per_source": per_source,
        "per_noise_feature": per_noise_feature,
        "trap_matrix": trap_matrix,
        "examples": {
            "misses": [row for row in rows if row["outcome"] == "fn"][:12],
            "false_positives": [row for row in rows if row["outcome"] == "fp"][:12],
            "tier2_escalations": [row for row in rows if row["prediction"]["escalate_to_tier2"]][:12],
        },
        "rows": rows,
    }
    return results


def classify_outcome(gold_positive: bool, predicted_positive: bool, type_match: bool) -> str:
    if gold_positive and predicted_positive and type_match:
        return "tp"
    if gold_positive:
        return "fn"
    if predicted_positive:
        return "fp"
    return "tn"


def platform_python() -> str:
    return platform.python_version()


def main() -> None:
    fixtures_path = Path(sys.argv[1]) if len(sys.argv) > 1 else FIXTURES_PATH
    results = evaluate(fixtures_path)
    RESULTS_PATH.write_text(json.dumps(results, indent=2))

    summary = results["summary"]
    print("Environment:")
    print(json.dumps(results["environment"], indent=2))
    print("\nDataset:")
    print(json.dumps(results["dataset"], indent=2))
    print("\nSummary:")
    print(json.dumps(summary, indent=2))
    print("\nPer-type recall:")
    print(json.dumps(results["per_type"], indent=2))
    print("\nPer-difficulty:")
    print(json.dumps(results["per_difficulty"], indent=2))
    print("\nPer-language:")
    print(json.dumps(results["per_language"], indent=2))
    print("\nPer-source:")
    print(json.dumps(results["per_source"], indent=2))
    print("\nPer-noise-feature:")
    print(json.dumps(results["per_noise_feature"], indent=2))
    print("\nTrap matrix:")
    print(json.dumps(results["trap_matrix"], indent=2))
    print("\nMisses:")
    for row in results["examples"]["misses"]:
        print(f"- {row['id']}: {row['text']} -> {row['prediction']}")
    print("\nFalse positives:")
    for row in results["examples"]["false_positives"]:
        print(f"- {row['id']}: {row['text']} -> {row['prediction']}")


if __name__ == "__main__":
    main()
