import re
import time
from typing import List, Tuple
import logging
from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider
from config import (
    NLP_SPACY_MODEL,
    NLP_LANGUAGE,
    TARGET_PII_ENTITIES,
    PII_CONFIDENCE_THRESHOLD,
)

logging.getLogger("presidio-analyzer").setLevel(logging.ERROR)

print(f"[PRE-FLIGHT] Loading spaCy NLP model ({NLP_SPACY_MODEL})...")
_nlp_load_start = time.perf_counter()
nlp_configuration = {
    "nlp_engine_name": "spacy",
    "models": [{"lang_code": "en", "model_name": NLP_SPACY_MODEL}],
}
provider = NlpEngineProvider(nlp_configuration=nlp_configuration)
nlp_engine = provider.create_engine()
print(f"[PRE-FLIGHT] spaCy NLP model loaded in {time.perf_counter() - _nlp_load_start:.2f}s")

print("[PRE-FLIGHT] Initializing Presidio PII analyzer...")
_analyzer_load_start = time.perf_counter()
pii_analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=[NLP_LANGUAGE])
print(f"[PRE-FLIGHT] Presidio PII analyzer ready in {time.perf_counter() - _analyzer_load_start:.2f}s")

# Deterministic Regex Fallbacks
EMAIL_REGEX = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
PHONE_REGEX = re.compile(r"(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
CARD_REGEX = re.compile(r"\b(?:\d[ -]*?){13,16}\b")

def find_pii_spans(text: str) -> List[Tuple[int, int]]:
    """Detects sensitive spans using Presidio analysis and regex fallback matching."""
    spans = []

    # 1. Presidio NLP Scan
    findings = pii_analyzer.analyze(
        text=text,
        language=NLP_LANGUAGE,
        entities=TARGET_PII_ENTITIES,
        score_threshold=PII_CONFIDENCE_THRESHOLD,
    )
    if findings:
        spans.extend([(f.start, f.end) for f in findings])

    # 2. Regex Patterns
    for r in [EMAIL_REGEX, PHONE_REGEX, CARD_REGEX]:
        for m in r.finditer(text):
            spans.append((m.start(), m.end()))

    return spans