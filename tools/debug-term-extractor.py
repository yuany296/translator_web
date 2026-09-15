from __future__ import annotations

import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "local-ocr-service"))

import term_extractor as terms

blocks = [
    {"id": str(index), "text": text}
    for index, text in enumerate([
        "김성현이 말했다.",
        "성현은 정다준 머리 위에 뜬 스탯을 보았다.",
        "하이파이브, 그리고 더 던. 샤이닝 스타 시즌2의 경연.",
        "하이파이브의 메인 댄서는 잡아먹히지 않았다.",
        "의상을 고이 벗어서 옷걸이에 걸어두었다.",
        "【미다스의 손】 케이팝의 심장이 반응한다.",
        "TEW, 애매하지만 그리 크게 걱정되진 않았다.",
    ])
]

print("== heuristic (sentence mode) ==")
for candidate in terms.extract_candidate_sentences(blocks):
    print(candidate)

print("== dispatch without upstream ==")
for candidate in terms.extract_term_candidates(blocks):
    print(candidate)

print("== status without base_url ==")
print(terms.get_term_extractor_status())

if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
    base_url = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 else "qwen2.5:7b"
    print("== LLM extraction via", base_url, model, "==")
    for candidate in terms.extract_term_candidates_llm(blocks, base_url, model, ""):
        print(candidate)
