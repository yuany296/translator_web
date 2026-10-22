from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field
from .runtime import runtime


class OcrRequest(BaseModel):
    image: str
    lang: str = "auto"
    mode: str = "fast"
    text_det_thresh: float | None = None
    text_det_box_thresh: float | None = None
    text_det_unclip_ratio: float | None = None
    text_rec_score_thresh: float | None = None
    rec_engine: str = Field(default="", max_length=24)
    debug: bool = False
    debug_id: str = ""
    ocr_geometry_version: str = Field(default="", max_length=64)
    seam_rows: list[int] = Field(default_factory=list, max_length=4)
    return_cleaned_image: bool = False
    cleaned_masks: list[dict[str, Any]] = Field(default_factory=list, max_length=200)
    cleaned_mask_token: str = Field(default="", max_length=128)


class BackgroundDebugRequest(BaseModel):
    image: str
    ocr: list[dict[str, Any]]
    labels: dict[str, str] = Field(default_factory=dict)
    parameterGroups: list[dict[str, Any]]


class TermExtractionBlock(BaseModel):
    id: str
    text: str
    translatedText: str = ""


class TermExtractionUpstream(BaseModel):
    baseUrl: str = ""
    model: str = ""
    apiKey: str = ""
    # 思考字段由扩展侧算好（extension/src/shared/thinking-mode.js 是唯一定义处），这里只转发。
    # 空 dict = 不干预，与服务商默认一致（也是升级前的行为）。
    thinking: dict[str, Any] = Field(default_factory=dict)


class TermExtractionRequest(BaseModel):
    blocks: list[TermExtractionBlock] = Field(default_factory=list, max_length=500)
    mode: str = "balanced"
    # 仅为兼容旧客户端（手机版旧包 / 旧桌面版）而保留：启发式与 LLM 两条分支都不读它。
    # 新客户端不再发送该字段——它曾经是"把术语库全量、且未过库开关/生效网址/语言/作用域过滤地
    # 发出去"的唯一载荷，删掉发送端是为了不让未过滤的术语流出。
    user_terms: list[str] = Field(default_factory=list, max_length=200)
    upstream: TermExtractionUpstream | None = None
    target_language: str = "zh-CN"


class GlossaryEntryPayload(BaseModel):
    id: str = ""
    source: str
    target: str
    src_lng: str = "ko"
    tgt_lng: str = ""
    note: str = ""
    enabled: bool = True
    scope_type: str = "global"
    scope_key: str = ""
    scope_label: str = ""
    library_id: str = ""
    library_name: str = ""


class GlossaryLibraryPayload(BaseModel):
    id: str = ""
    name: str = ""
    enabled: bool = True
    urls: list[str] = Field(default_factory=list, max_length=20)
    applyUrls: list[str] = Field(default_factory=list, max_length=20)


class GlossaryBatchPayload(BaseModel):
    entries: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    tgt_lng: str = ""
    src_lng: str = "ko"


class GlossaryConfirmPayload(BaseModel):
    source: str
    target: str


class GlossaryIgnorePayload(BaseModel):
    source: str


class GlossaryAddPendingPayload(BaseModel):
    source: str
    kind: str = "proper_noun"
    score: float = 0.0
    evidence_ids: list[Any] = Field(default_factory=list, max_length=50)
    chapter_key: str = ""
    chapter_url: str = ""
    chapter_title: str = ""
    library_id: str = ""


class GlossaryImportPayload(BaseModel):
    entries: list = Field(default_factory=list, max_length=1000)


class TranslationQueryPayload(BaseModel):
    recordKeys: list[str] = Field(default_factory=list, max_length=500)
    includeDeleted: bool = False


class TranslationOperationsPayload(BaseModel):
    operations: list[dict[str, Any]] = Field(default_factory=list, min_length=1, max_length=500)


class TranslationImportPayload(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    confirmation: str = Field(default="", max_length=80)


class TranslationStreamPayload(BaseModel):
    taskId: str = Field(min_length=1, max_length=160)
    items: list[dict[str, Any]] = Field(default_factory=list, min_length=1, max_length=200)
    upstream: dict[str, Any]
    sourceLanguage: str = Field(default="auto", max_length=24)
    targetLanguage: str = Field(default="zh-CN", max_length=24)
    configFingerprint: str = Field(default="", max_length=200)
    context: dict[str, Any] = Field(default_factory=dict)
    glossary: list[dict[str, Any]] = Field(default_factory=list, max_length=1000)


runtime.__dict__.update({name: value for name, value in globals().items() if isinstance(value, type) and issubclass(value, BaseModel)})
