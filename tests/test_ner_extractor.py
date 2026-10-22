"""NER 术语提取（model 侧 + 主服务侧）的单元测试。

刻意不加载真模型、不 import torch：推理在独立 worker 进程里跑（torch 与 paddle 的
CUDA DLL 在 Windows 上同进程互斥），测试只验证切块/后处理/分派/降级这些我们自己写的逻辑。
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "local-ocr-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

import ner_extractor  # noqa: E402
import ner_worker  # noqa: E402


def fake_pipeline(entities: list[dict[str, Any]], calls: list[str] | None = None):
    """返回固定实体列表的 pipeline 替身。"""

    def pipe(text: str) -> list[dict[str, Any]]:
        if calls is not None:
            calls.append(text)
        return entities

    return pipe


def entity(word: str, label: str, score: float, start: int) -> dict[str, Any]:
    return {"word": word, "entity_group": label, "score": score, "start": start, "end": start + len(word)}


def run(monkeypatch: pytest.MonkeyPatch, blocks: list[dict[str, Any]], entities: list[dict[str, Any]],
        calls: list[str] | None = None) -> tuple[list[dict[str, Any]], dict[str, int]]:
    monkeypatch.setattr(ner_worker, "get_pipeline", lambda: fake_pipeline(entities, calls))
    return ner_worker.extract_term_candidates_ner(blocks)


# ---------- 后处理 ----------

def test_normalize_keeps_particle_like_endings() -> None:
    """单字助词不剥：剥了会把「마을」「레이나」砍成「마」「레이」。"""
    assert ner_worker.normalize_term("철벽 마을") == "철벽 마을"
    assert ner_worker.normalize_term("레이나") == "레이나"
    assert ner_worker.normalize_term("한지우") == "한지우"


def test_normalize_strips_multichar_josa() -> None:
    assert ner_worker.normalize_term("칼릭이라는") == "칼릭"
    assert ner_worker.normalize_term("레이나에서") == "레이나"


def test_normalize_strips_role_tail() -> None:
    """空格后的职衔不是术语的一部分。"""
    assert ner_worker.normalize_term("서도현 책임") == "서도현"
    assert ner_worker.normalize_term("서울역 대합실") == "서울역"
    # 没有空格不剥，避免误伤以这些字结尾的普通词。
    assert ner_worker.normalize_term("대합실") == "대합실"


# ---------- 提取 ----------

def test_extract_maps_labels_to_kinds(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "칼릭과 레이나가 루멘시티에서 백야 기사단을 만났다."
    entities = [
        entity("칼릭", "PER", 0.99, 0),
        entity("레이나", "PER", 0.95, 5),
        entity("루멘시티", "LOC", 0.9, 13),
        entity("백야 기사단", "ORG", 0.88, 19),
        entity("월광석", "PRD", 0.8, 26),
        entity("이상한것", "MISC", 0.8, 30),
    ]
    candidates, stats = run(monkeypatch, [{"id": "b1", "text": text}], entities)
    kinds = {item["source"]: item["kind"] for item in candidates}
    assert kinds["칼릭"] == "person"
    assert kinds["레이나"] == "person"
    assert kinds["루멘시티"] == "location"
    assert kinds["백야 기사단"] == "organization"
    assert kinds["월광석"] == "group"
    assert stats["nerChunks"] == 1


def test_extract_drops_low_score(monkeypatch: pytest.MonkeyPatch) -> None:
    """0.70 是实测拐点，低于它的不进去（否则满屏半个词）。"""
    text = "그란티아 왕국과 칼릭"
    entities = [entity("그란티아 왕국", "ORG", 0.63, 0), entity("칼릭", "PER", 0.91, 9)]
    candidates, _stats = run(monkeypatch, [{"id": "b1", "text": text}], entities)
    assert [item["source"] for item in candidates] == ["칼릭"]


def test_extract_extends_dropped_surname(monkeypatch: pytest.MonkeyPatch) -> None:
    """模型会把姓切掉（한지우 → 지우）；紧跟在前面的韩文字就是姓。"""
    text = "한지우는 대전역으로 갔다."
    entities = [entity("지우", "PER", 0.84, 1)]
    candidates, _stats = run(monkeypatch, [{"id": "b1", "text": text}], entities)
    assert [item["source"] for item in candidates] == ["한지우"]


def test_extract_keeps_name_when_preceded_by_space(monkeypatch: pytest.MonkeyPatch) -> None:
    """有空格隔开就不是姓，别粘上去（否则 카엘 会变成 사카엘）。"""
    text = "대마법사 카엘 휘"
    entities = [entity(" 카엘", "PER", 0.93, 4)]
    candidates, _stats = run(monkeypatch, [{"id": "b1", "text": text}], entities)
    assert [item["source"] for item in candidates] == ["카엘"]


def test_extract_does_not_extend_non_person(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "서울 마포구"
    entities = [entity("마포구", "LOC", 0.9, 3)]
    candidates, _stats = run(monkeypatch, [{"id": "b1", "text": text}], entities)
    assert [item["source"] for item in candidates] == ["마포구"]


def test_extract_merges_duplicates_and_keeps_max_score(monkeypatch: pytest.MonkeyPatch) -> None:
    text = "칼릭은 웃었다. 칼릭은 울었다."
    entities = [entity("칼릭", "PER", 0.80, 0)]
    blocks = [{"id": "b1", "text": text}]
    monkeypatch.setattr(ner_worker, "get_pipeline", lambda: fake_pipeline(entities))
    # 两个 chunk 会各跑一次，同一个词只留一条并按最高分记。
    candidates, stats = ner_worker.extract_term_candidates_ner(blocks)
    assert stats["nerChunks"] >= 1
    assert len(candidates) == 1
    assert candidates[0]["source"] == "칼릭"


def test_extract_maps_evidence_to_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    """术语要能指回它出现的原文块（扩展侧靠它做「在哪一章出现过」）。"""
    blocks = [{"id": "b1", "text": "세리안이 왔다."}, {"id": "b2", "text": "카일런은 갔다."}]
    joined = "세리안이 왔다.\n카일런은 갔다."
    entities = [entity("카일런", "PER", 0.95, joined.index("카일런"))]
    candidates, _stats = run(monkeypatch, blocks, entities)
    assert candidates[0]["source"] == "카일런"
    assert candidates[0]["evidenceIds"] == ["b2"]


def test_extract_returns_empty_without_pipeline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ner_worker, "get_pipeline", lambda: None)
    candidates, stats = ner_worker.extract_term_candidates_ner([{"id": "b1", "text": "칼릭은 웃었다."}])
    assert candidates == []
    assert stats == {"nerChunks": 0, "nerDropped": 0}


def test_extract_skips_blocks_without_id(monkeypatch: pytest.MonkeyPatch) -> None:
    entities = [entity("칼릭", "PER", 0.9, 0)]
    candidates, _stats = run(monkeypatch, [{"id": "", "text": "칼릭은 웃었다."}], entities)
    assert candidates == []


# ---------- 切块 ----------

def test_split_text_covers_whole_text() -> None:
    text = ("세리안은 문을 열었다. " * 80).strip()
    pieces = ner_worker._split_text(text)
    assert pieces[0][0] == 0
    covered = [False] * len(text)
    for offset, piece in pieces:
        for index in range(offset, offset + len(piece)):
            covered[index] = True
    assert all(covered)
    assert max(len(piece) for _offset, piece in pieces) <= ner_worker.CHUNK_CHARS


# ---------- 状态与降级 ----------

def make_model_dir(directory: Path, files: tuple[str, ...] = ner_extractor.MODEL_REQUIRED_FILES) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name in files:
        (directory / name).write_text("{}", encoding="utf-8")
    return directory


def test_status_unavailable_when_model_missing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCAL_OCR_NER_MODEL_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "")
    status = ner_extractor.get_ner_status()
    assert status["available"] is False
    assert "NER 模型缺失" in status["error"]


def test_status_available_when_files_present(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCAL_OCR_NER_MODEL_DIR", str(make_model_dir(tmp_path / "model")))
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "")
    monkeypatch.setattr(ner_extractor, "_WORKER", None)
    assert ner_extractor.get_ner_status()["available"] is True


def test_engine_status_is_none_without_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """模型缺失不是故障，但也**不再有兜底算法**：报 none 并说清原因。"""
    monkeypatch.setenv("LOCAL_OCR_NER_MODEL_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "")
    status = ner_extractor.ner_engine_status()
    assert status["available"] is True
    assert status["engine"] == "none"
    assert status["nerAvailable"] is False
    assert status["nerError"]


def test_engine_status_reports_ner(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCAL_OCR_NER_MODEL_DIR", str(make_model_dir(tmp_path / "model")))
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "")
    monkeypatch.setattr(ner_extractor, "_WORKER", None)
    status = ner_extractor.ner_engine_status()
    assert status["engine"] == "ner"
    assert status["nerAvailable"] is True


def test_try_extract_returns_none_when_worker_fails(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """worker 崩了只让调用方拿到空结果，不能抛异常把整章提取打挂。"""
    monkeypatch.setenv("LOCAL_OCR_NER_MODEL_DIR", str(make_model_dir(tmp_path / "model")))
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "")
    monkeypatch.setattr(ner_extractor, "_WORKER", None)
    monkeypatch.setattr(ner_extractor, "_roundtrip", lambda payload: {})
    assert ner_extractor.try_extract_ner_candidates([{"id": "b1", "text": "칼릭은 웃었다."}]) is None


def test_try_extract_skips_when_status_unavailable(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCAL_OCR_NER_MODEL_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "")
    called: list[dict[str, Any]] = []

    def boom(payload: dict[str, Any]) -> dict[str, Any]:
        called.append(payload)
        raise AssertionError("模型不在位时不该去拉 worker")

    monkeypatch.setattr(ner_extractor, "_roundtrip", boom)
    assert ner_extractor.try_extract_ner_candidates([{"id": "b1", "text": "칼릭은 웃었다."}]) is None
    assert called == []


# ---------- 分派 ----------

def test_dispatch_prefers_ner(monkeypatch: pytest.MonkeyPatch) -> None:
    import term_extractor

    expected = ([{"source": "칼릭", "kind": "person", "score": 0.9, "evidenceIds": ["b1"]}], {"nerChunks": 1})
    monkeypatch.setattr(term_extractor, "try_extract_ner_candidates", lambda blocks: expected)
    candidates, stats = term_extractor.extract_term_candidates_with_stats([{"id": "b1", "text": "칼릭은 웃었다."}])
    assert candidates == expected[0]
    assert stats == {"nerChunks": 1}


def test_dispatch_returns_nothing_when_ner_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    """没有第三条路：NER 不给结果就空着，绝不启用「句子模式」这种垃圾生成器。"""
    import term_extractor

    monkeypatch.setattr(term_extractor, "try_extract_ner_candidates", lambda blocks: None)
    candidates, stats = term_extractor.extract_term_candidates_with_stats([{"id": "b1", "text": "김성현이 말했다."}])
    assert candidates == []
    assert stats == {}


def test_dispatch_keeps_llm_first(monkeypatch: pytest.MonkeyPatch) -> None:
    """配了 LLM 就走 LLM，不能被本地模型抢走。"""
    import term_extractor

    seen: list[str] = []
    monkeypatch.setattr(term_extractor, "try_extract_ner_candidates", lambda blocks: seen.append("ner"))
    monkeypatch.setattr(term_extractor, "extract_term_candidates_llm_with_stats",
                        lambda *a, **k: ([{"source": "llm"}], {"dropped": 0}))
    candidates, _stats = term_extractor.extract_term_candidates_with_stats(
        [{"id": "b1", "text": "칼릭은 웃었다."}], {"baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b"})
    assert candidates == [{"source": "llm"}]
    assert seen == []


# ---------- 预热 ----------

def test_warm_up_fails_clearly_when_model_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ner_extractor, "get_ner_status", lambda: {"available": False, "error": "NER 模型缺失"})
    assert ner_extractor.warm_up() == {"warmed": False, "elapsedMs": 0, "error": "NER 模型缺失"}


def test_warm_up_runs_one_short_roundtrip(monkeypatch: pytest.MonkeyPatch) -> None:
    """预热就是「拉起 worker + 一句最小推理」：不带真实语料，不产出候选。"""
    monkeypatch.setattr(ner_extractor, "get_ner_status", lambda: {"available": True, "error": ""})
    seen: dict[str, Any] = {}

    def fake_roundtrip(payload: dict[str, Any]) -> dict[str, Any]:
        seen.update(payload)
        return {"candidates": [], "stats": {}}

    monkeypatch.setattr(ner_extractor, "_roundtrip", fake_roundtrip)
    result = ner_extractor.warm_up()
    assert result["warmed"] is True
    assert result["error"] == ""
    assert seen["blocks"][0]["id"] == "warmup"


def test_warm_up_reports_inference_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ner_extractor, "get_ner_status", lambda: {"available": True, "error": ""})
    monkeypatch.setattr(ner_extractor, "_roundtrip", lambda payload: {"error": "cuda oom"})
    result = ner_extractor.warm_up()
    assert result["warmed"] is False
    assert "cuda oom" in result["error"]


def test_is_warm_needs_live_worker_and_no_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ner_extractor, "_worker_alive", lambda: False)
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "")
    assert ner_extractor.is_warm() is False
    monkeypatch.setattr(ner_extractor, "_worker_alive", lambda: True)
    assert ner_extractor.is_warm() is True
    monkeypatch.setattr(ner_extractor, "_WORKER_ERROR", "worker 无响应")
    assert ner_extractor.is_warm() is False
