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


class TermExtractionRequest(BaseModel):
    blocks: list[TermExtractionBlock] = Field(default_factory=list, max_length=200)
    mode: str = "balanced"
    user_terms: list[str] = Field(default_factory=list, max_length=200)


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


class GlossaryImportPayload(BaseModel):
    entries: list = Field(default_factory=list, max_length=1000)


class TranslationPairPayload(BaseModel):
    pairingCode: str = Field(min_length=6, max_length=128)
    token: str = Field(min_length=32, max_length=512)


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
