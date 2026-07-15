from __future__ import annotations

import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "local-ocr-service"))

import term_extractor as terms

kiwi = terms.get_kiwi()
for text in ["성현", "김성현", "김솔음", "마법사", "학교", "샤이닝 스타", "연습 시간"]:
    tokens = terms.normalize_tokens(kiwi.tokenize(text), text)
    print(text, tokens)
    print("  korean=", terms.extract_korean_candidates(text, tokens))
    print("  usable=", terms.is_usable_candidate(text))
print("batch=", terms.extract_term_candidates([
    {"id": str(index), "text": text}
    for index, text in enumerate(["성현", "김성현", "김솔음", "마법사", "학교", "샤이닝 스타", "연습 시간"])
]))
