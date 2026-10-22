"""NER 独立 worker：跑在单独进程里，避免 torch 与 paddle 的 CUDA DLL 冲突。

Windows 上 torch 与 paddle 同进程互相加载失败（WinError 127，两种导入顺序都试过，
manga-ocr 已经为此付出过代价）——主服务一启动就 import paddle，同一进程里再 import
transformers 必挂。所以模型推理放在这里：stdin 逐行读 {"blocks": [{id,text}...]}，
stdout 逐行回 {"candidates": [...], "stats": {...}}。启动先回一行 {"ready": true}。

只 import torch/transformers 与本目录的纯工具模块，**绝不 import ocr_service（paddle）**。
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections.abc import Iterable
from typing import Any

from ner_extractor import MODEL_REQUIRED_FILES, model_dir
from term_text_utils import MAX_SOURCE_LENGTH, contains_hangul, normalize_candidate, normalize_text

# 0.70 是实测最优（72 实体评测里 precision 0.74 / recall 0.67 的拐点，见 ner/ko/results/REPORT.md）。
SCORE_THRESHOLD = 0.70
# 每块 384 字符：modernbert 训练长度 512 token，韩文约 1.2 token/字，再长会截断。
CHUNK_CHARS = 384
CHUNK_OVERLAP = 48
KIND_BY_LABEL = {"PER": "person", "LOC": "location", "ORG": "organization", "PRD": "group"}

# 韩语助词后缀（多字，按长度倒序匹配）。
# **刻意不收单字助词**（은/는/이/가/을/를/의/에/도/만/로/나）：实测这个模型输出的就是干净
# 专名、本来不带助词（칼릭은→칼릭，레이나가→레이나，대전역으로→대전역），剥单字助词反而
# 把自己砍坏 —— 철벽 마을→철벽 마（吃掉「을」）、레이나→레이（吃掉「나」），实测让整体 F1
# 从 0.647 掉到更低。多字助词没有这种歧义：没有地名以 에서/이라고 结尾。
JOSA_SUFFIXES = sorted(
    (
        "에게서는", "으로부터", "이라고는", "에서부터", "에게서", "으로써", "이라도", "에서는",
        "에게는", "으로는", "이란", "이라는", "이라고", "이라며", "이지만", "이었", "입니다",
        "이다", "이야", "에서", "에게", "에는", "에도", "에만", "라는", "라고", "라며", "라도",
        "으로", "까지", "부터", "보다", "처럼", "하고", "이랑", "이나", "께서",
    ),
    key=len,
    reverse=True,
)

# 空格后的职衔/泛称尾巴：'서도현 책임'、'서울역 3층 대합실' 这类尾巴对术语表没用。
# 只在**有空格**时才剥，避免把 이름 本身的后缀当职衔（부산/세종시 之类不会被误伤）。
TAIL_NOISE = {
    "책임", "대표", "변호사", "분석관", "수사관", "검사", "판사", "기자", "교수", "박사",
    "사장", "팀장", "부장", "과장", "차장", "원장", "소장", "의원", "비서", "경위", "반장",
    "대합실", "출입구", "입구", "앞", "근처", "부근", "일대", "주변", "내부", "외곽", "방향",
}

_PIPELINE: Any = None
_ERROR = ""


def _device() -> int:
    """pipeline 的 device 参数：-1=CPU，0=第一块 GPU。默认 CPU，见 start_local_ocr_gpu.bat。"""
    mode = str(os.environ.get("LOCAL_OCR_NER_DEVICE") or "cpu").strip().lower()
    if mode == "cuda":
        return 0
    if mode != "auto":
        return -1
    try:
        import torch
        return 0 if torch.cuda.is_available() else -1
    except Exception:  # noqa: BLE001 - 没有 torch 就是 CPU，不值得让整个 worker 挂掉
        return -1


def get_pipeline() -> Any:
    """懒加载单例。失败返回 None 并把原因记进 _ERROR，主服务据此降级到启发式。"""
    global _PIPELINE, _ERROR
    if _PIPELINE is not None:
        return _PIPELINE
    directory = model_dir()
    missing = [name for name in MODEL_REQUIRED_FILES if not (directory / name).is_file()]
    if missing:
        _ERROR = f"NER 模型缺失：{directory} 下找不到 {', '.join(missing)}"
        return None
    try:
        from transformers import pipeline
        _PIPELINE = pipeline(
            "token-classification",
            model=str(directory),
            tokenizer=str(directory),
            aggregation_strategy="simple",
            device=_device(),
        )
        _ERROR = ""
    except Exception as exc:  # noqa: BLE001 - 加载失败只降级，不中断术语提取
        _ERROR = f"NER 模型加载失败：{exc}"
        _PIPELINE = None
    return _PIPELINE


def strip_josa(surface: str) -> str:
    """剥掉尾部助词：칼릭은 → 칼릭，레이나가 → 레이나，백서준이라는 → 백서준。

    剥完至少留 2 个字，否则 '레이' 会被 '이' 砍成 '레'。
    """
    value = surface
    for suffix in JOSA_SUFFIXES:
        if value.endswith(suffix) and len(value) - len(suffix) >= 2:
            return value[: -len(suffix)]
    return value


def strip_tail_noise(surface: str) -> str:
    """剥掉空格后的职衔/泛称尾巴：'서도현 책임' → '서도현'，'서울역 대합실' → '서울역'。"""
    value = surface.strip()
    while " " in value:
        head, _, tail = value.rpartition(" ")
        if tail not in TAIL_NOISE or len(head.strip()) < 2:
            break
        value = head.strip()
    return value


def normalize_term(surface: str) -> str:
    return normalize_candidate(strip_tail_noise(strip_josa(normalize_candidate(surface))))


def _split_text(text: str) -> list[tuple[int, str]]:
    """按句子边界切块，返回 [(起始偏移, 片段)]。重叠 48 字避免把实体切在边界上。"""
    pieces: list[tuple[int, str]] = []
    start = 0
    length = len(text)
    while start < length:
        end = min(start + CHUNK_CHARS, length)
        if end < length:
            cut = max(text.rfind(mark, start + CHUNK_CHARS // 2, end) for mark in (". ", "! ", "? ", "\n"))
            if cut > 0:
                end = cut + 1
        pieces.append((start, text[start:end]))
        if end >= length:
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return pieces


def _block_ids_for_span(joined: str, spans: list[tuple[int, int, str]], start: int, end: int) -> list[str]:
    """联合文本里的字符区间 → 覆盖它的 block id（按段首偏移判断）。"""
    ids: list[str] = []
    for block_start, block_end, block_id in spans:
        if start < block_end and end > block_start and block_id not in ids:
            ids.append(block_id)
    return ids


def _prepare_blocks(blocks: Iterable[dict[str, Any]]) -> tuple[str, list[tuple[int, int, str]]]:
    """把一段话的所有 block 拼成一段带偏移的联合文本。"""
    parts: list[str] = []
    spans: list[tuple[int, int, str]] = []
    cursor = 0
    for block in blocks:
        block_id = str(block.get("id") or "").strip()
        text = normalize_text(block.get("text"))
        if not block_id or not text:
            continue
        if parts:
            cursor += 1  # 换行分隔符
        spans.append((cursor, cursor + len(text), block_id))
        parts.append(text)
        cursor += len(text)
    return "\n".join(parts), spans


def extract_term_candidates_ner(
    blocks: Iterable[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """返回 (候选, 丢弃统计)；候选形状与 LLM 那条路一致，下游合并逻辑不用分叉。

    返回 (候选列表, {"nerChunks": n, "nerDropped": m})。模型不可用时返回 ([], {...})，
    由调用方落回启发式 —— 这里绝不抛异常。
    """
    prepared = [block for block in blocks if str(block.get("id") or "").strip()]
    pipe = get_pipeline()
    if pipe is None or not prepared:
        return [], {"nerChunks": 0, "nerDropped": 0}

    joined, spans = _prepare_blocks(prepared)
    if not joined.strip():
        return [], {"nerChunks": 0, "nerDropped": 0}

    merged: dict[str, dict[str, Any]] = {}
    dropped = 0
    chunks = _split_text(joined)
    for offset, piece in chunks:
        try:
            entities = pipe(piece)
        except Exception:  # noqa: BLE001 - 单块失败不该让整话提取归零
            continue
        for entity in entities:
            # word 可能带前导空格（' 이그니스'），而 start 指的是**那个空格**的位置。
            # 必须在 strip 之前量缩进量，否则偏移整体错 1 格：术语会被判定成不属于任何
            # block，还可能把前一个字粘进来（实测 카엘 → 사카엘）。
            raw = str(entity.get("word") or "")
            lead = len(raw) - len(raw.lstrip())
            surface = raw.strip()
            label = str(entity.get("entity_group") or "").upper()
            score = float(entity.get("score") or 0.0)
            if score < SCORE_THRESHOLD:
                continue
            source = normalize_term(surface)
            if len(source) < 2 or len(source) > MAX_SOURCE_LENGTH:
                dropped += 1
                continue
            start = offset + int(entity.get("start") or 0) + lead
            # 模型会把姓切掉：한지우→지우、윤세라→세라、백서준→서준（实测 8/8 全中）。
            # 紧贴在前的韩文字没有空格隔开，就是姓，补回去。只在预测恰好 2 字时补，
            # 避免把「칼릭」「이그니스」这类完整名再粘上前一个字。
            if label == "PER" and len(source) == 2 and start > 0 and contains_hangul(joined[start - 1]):
                source = joined[start - 1] + source
                start -= 1
            end = start + len(surface)
            evidence = _block_ids_for_span(joined, spans, start, end)
            key = source.casefold()
            current = merged.get(key)
            if current is None:
                merged[key] = {
                    "source": source,
                    "kind": KIND_BY_LABEL.get(label, "proper_noun"),
                    "score": round(score, 4),
                    "note": "",
                    "suggestedTarget": "",
                    "evidenceIds": evidence,
                    "sentenceOnly": False,
                }
                continue
            current["score"] = round(max(float(current["score"]), score), 4)
            for block_id in evidence:
                if block_id not in current["evidenceIds"]:
                    current["evidenceIds"].append(block_id)

    candidates = sorted(
        merged.values(),
        key=lambda item: (-float(item["score"]), -len(str(item["source"])), str(item["source"])),
    )
    return candidates, {"nerChunks": len(chunks), "nerDropped": dropped}


def main() -> None:
    """一行请求一行回复。先回 ready（不加载模型，免得每次重启都卡十几秒）。"""
    print(json.dumps({"ready": True, "model": str(model_dir())}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        started = time.monotonic()
        try:
            request = json.loads(line)
            candidates, stats = extract_term_candidates_ner(request.get("blocks") or [])
            if _ERROR:
                print(json.dumps({"error": _ERROR}), flush=True)
                continue
            print(json.dumps({
                "candidates": candidates,
                "stats": stats,
                "elapsedMs": int((time.monotonic() - started) * 1000),
            }, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001 - 单次请求失败不拖垮 worker
            print(json.dumps({"error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
