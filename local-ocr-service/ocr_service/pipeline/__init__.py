"""按依赖顺序装配 OCR 服务领域模块。"""

from . import api_handlers
from . import orchestrator
from . import appearance_regions
from . import appearance_colors
from . import debug_artifacts
from . import preprocess
from . import paddle_provider
from . import result_parsing
from . import dedupe_candidates
from . import value_utils
from . import crop_geometry
from . import crop_recognition
from . import translation_api
from . import translation_stream
