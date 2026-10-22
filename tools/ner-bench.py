"""用人工标注集量一遍「真实链路」的 NER 术语提取（不是量模型本身）。

区别很重要：`AI_work/ner/ko/bench/eval_ner.py` 量的是裸模型的 token 级输出，这里量的是
**插件里真正跑出来的那一步** —— 分块、阈值、助词/职衔后处理、姓补全、worker 进程通信全算进去。
所以这个脚本的分数才是用户看到的效果。

用法（必须在装了 transformers + 模型已落盘的机器上跑）：

    python tools/ner-bench.py [gold_ko.json]

默认读 `C:/homework/AI_work/ner/ko/bench/gold_ko.json`，它引用的 txt 与 gold 同目录的上一级。
每个文本按空行切块喂进去（与扩展侧一章的切法一致），指标是**集合级精确匹配**的 P/R/F1。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))

import ner_extractor as ner  # noqa: E402

DEFAULT_GOLD = Path(r"C:\homework\AI_work\ner\ko\bench\gold_ko.json")


def blocks_for(text: str) -> list[dict[str, str]]:
    return [
        {"id": "b%d" % index, "text": part.strip()}
        for index, part in enumerate(text.split("\n\n"))
        if part.strip()
    ]


def main() -> None:
    gold_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_GOLD
    gold = json.loads(gold_path.read_text(encoding="utf-8"))
    corpus_root = gold_path.parent.parent
    status = ner.get_ner_status()
    print("模型目录:", ner.model_dir())
    print("状态:", status)
    if not status["available"]:
        print("模型不在位，跑不了。")
        return
    total_tp = total_pred = total_gold = 0
    for name, entry in gold.items():
        if name.startswith("_"):
            continue
        text = (corpus_root / entry["file"]).read_text(encoding="utf-8")
        blocks = blocks_for(text)
        started = time.monotonic()
        result = ner.try_extract_ner_candidates(blocks)
        elapsed = time.monotonic() - started
        preds = [item["source"] for item in result[0]] if result else []
        golds = [item["term"] for item in entry["core"]]
        hit = len(set(preds) & set(golds))
        total_tp += hit
        total_pred += len(preds)
        total_gold += len(golds)
        precision = hit / len(preds) if preds else 0.0
        recall = hit / len(golds) if golds else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        chars = sum(len(block["text"]) for block in blocks)
        print("\n== %s（%d 字 / %d 块 / %.1fs / %.0f 字每秒）==" % (name, chars, len(blocks), elapsed,
                                                          chars / elapsed if elapsed else 0))
        print("  gold=%d pred=%d  P=%.3f R=%.3f F1=%.3f" % (len(golds), len(preds), precision, recall, f1))
        print("  漏:", " / ".join(term for term in golds if term not in set(preds)))
        print("  多:", " / ".join(term for term in preds if term not in set(golds)))
    precision = total_tp / total_pred if total_pred else 0.0
    recall = total_tp / total_gold if total_gold else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    print("\nTOTAL  tp=%d pred=%d gold=%d  P=%.3f R=%.3f F1=%.3f" % (total_tp, total_pred, total_gold,
                                                                 precision, recall, f1))


if __name__ == "__main__":
    main()
