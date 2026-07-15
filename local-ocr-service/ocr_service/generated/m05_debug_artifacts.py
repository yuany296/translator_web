from __future__ import annotations

from ..dependencies import runtime

def get_image_size(image_bytes: bytes) -> tuple[int, int]:
    try:
        with runtime.Image.open(runtime.io.BytesIO(image_bytes)) as image:
            return (int(image.width), int(image.height))
    except Exception:
        return (0, 0)

runtime.get_image_size = get_image_size

def safe_debug_stem(debug_id: str) -> str:
    raw = ''.join((ch if ch.isalnum() or ch in {'-', '_'} else '-' for ch in str(debug_id or '').strip()))
    return raw[:80] or f'ocr-{runtime.os.getpid()}-{runtime.threading.get_ident()}'

runtime.safe_debug_stem = safe_debug_stem

def save_debug_input(image_bytes: bytes, debug_id: str) -> str:
    runtime.DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    path = runtime.DEBUG_DIR / f'input-{runtime.safe_debug_stem(debug_id)}.png'
    try:
        image = runtime.Image.open(runtime.io.BytesIO(image_bytes)).convert('RGB')
        image.save(path)
    except Exception:
        path.write_bytes(image_bytes)
    return str(path)

runtime.save_debug_input = save_debug_input

def save_debug_boxes(image_bytes: bytes, items: list[dict[str, runtime.Any]], debug_id: str) -> str:
    runtime.DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    path = runtime.DEBUG_DIR / f'boxes-{runtime.safe_debug_stem(debug_id)}.png'
    image = runtime.Image.open(runtime.io.BytesIO(image_bytes)).convert('RGB')
    draw = runtime.ImageDraw.Draw(image)
    for item in items:
        box = item.get('box') if isinstance(item, dict) else None
        if not isinstance(box, dict):
            continue
        left = float(box.get('left') or 0)
        top = float(box.get('top') or 0)
        width = float(box.get('width') or 0)
        height = float(box.get('height') or 0)
        if width <= 0 or height <= 0:
            continue
        right = left + width
        bottom = top + height
        draw.rectangle([left, top, right, bottom], outline=(255, 0, 0), width=3)
        label = str(item.get('text') or '')[:24]
        if label:
            draw.text((left + 2, max(0, top - 14)), label, fill=(255, 0, 0))
    image.save(path)
    return str(path)

runtime.save_debug_boxes = save_debug_boxes

def service_debug_dir(name: str) -> runtime.Path:
    path = runtime.SERVICE_DEBUG_ROOT / name
    path.mkdir(parents=True, exist_ok=True)
    return path

runtime.service_debug_dir = service_debug_dir

def save_service_input_received(image_bytes: bytes, stem: str) -> str:
    path = runtime.service_debug_dir('input_received') / f'{stem}.png'
    image = runtime.Image.open(runtime.io.BytesIO(image_bytes)).convert('RGB')
    image.save(path)
    return str(path)

runtime.save_service_input_received = save_service_input_received

def save_service_plugin_input(image_bytes: bytes, stem: str) -> str:
    path = runtime.service_debug_dir('plugin_input') / f'{stem}.png'
    image = runtime.Image.open(runtime.io.BytesIO(image_bytes)).convert('RGB')
    image.save(path)
    return str(path)

runtime.save_service_plugin_input = save_service_plugin_input

def save_service_input_to_paddle(variants: list[dict[str, runtime.Any]], stem: str) -> list[str]:
    output_dir = runtime.service_debug_dir('input_to_paddle')
    paths = []
    for variant in variants:
        name = str(variant.get('name') or 'variant')
        src = runtime.Path(variant['path'])
        dst = output_dir / f'{stem}-{name}.png'
        runtime.shutil.copyfile(src, dst)
        paths.append(str(dst))
    return paths

runtime.save_service_input_to_paddle = save_service_input_to_paddle

def save_service_raw_result(raw_result: runtime.Any, items: list[dict[str, runtime.Any]], stem: str, variant: dict[str, runtime.Any], lang: str) -> str:
    name = runtime.safe_debug_stem(f"{stem}-{variant.get('name', 'variant')}-{lang}")
    path = runtime.service_debug_dir('raw_result') / f'{name}.json'
    payload = {'variant': variant.get('name', ''), 'lang': lang, 'scale': variant.get('scale', 1.0), 'raw': runtime.to_plain(raw_result), 'extracted_items': items, 'raw_items_count': len(items)}
    path.write_text(runtime.json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
    return str(path)

runtime.save_service_raw_result = save_service_raw_result

def save_service_crops(image_path: runtime.Path | str, items: list[dict[str, runtime.Any]], stem: str, variant: dict[str, runtime.Any], lang: str) -> list[str]:
    output_dir = runtime.service_debug_dir('crops') / runtime.safe_debug_stem(stem)
    output_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    try:
        image = runtime.Image.open(image_path).convert('RGB')
    except Exception:
        return paths
    for index, item in enumerate(items, start=1):
        box = item.get('box')
        if not isinstance(box, dict):
            continue
        left = max(0, int(float(box.get('left') or 0)))
        top = max(0, int(float(box.get('top') or 0)))
        right = min(image.width, int(float(box.get('left') or 0) + float(box.get('width') or 0)))
        bottom = min(image.height, int(float(box.get('top') or 0) + float(box.get('height') or 0)))
        if right <= left or bottom <= top:
            continue
        text_slug = runtime.safe_debug_stem(str(item.get('text') or 'text'))[:24]
        path = output_dir / f"{runtime.safe_debug_stem(str(variant.get('name') or 'variant'))}-{lang}-{index:03d}-{text_slug}.png"
        image.crop((left, top, right, bottom)).save(path)
        paths.append(str(path))
    return paths

runtime.save_service_crops = save_service_crops

def save_service_result_json(result: dict[str, runtime.Any], stem: str) -> str:
    path = runtime.service_debug_dir('result_json') / f'{stem}.json'
    path.write_text(runtime.json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
    return str(path)

runtime.save_service_result_json = save_service_result_json

def save_service_latest_debug_index(debug_paths: dict[str, runtime.Any], stem: str) -> str:
    path = runtime.SERVICE_DEBUG_ROOT / 'LATEST_DEBUG_PATHS.json'
    payload = {'debug_id': stem, 'updated_at': runtime.time.strftime('%Y-%m-%d %H:%M:%S'), 'paths': debug_paths}
    runtime.SERVICE_DEBUG_ROOT.mkdir(parents=True, exist_ok=True)
    path.write_text(runtime.json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
    return str(path)

runtime.save_service_latest_debug_index = save_service_latest_debug_index

def save_service_vis(image_bytes: bytes, items: list[dict[str, runtime.Any]], stem: str) -> str:
    path = runtime.service_debug_dir('vis') / f'{stem}.png'
    image = runtime.Image.open(runtime.io.BytesIO(image_bytes)).convert('RGB')
    runtime.draw_debug_boxes(image, items).save(path)
    return str(path)

runtime.save_service_vis = save_service_vis

def draw_debug_boxes(image: runtime.Image.Image, items: list[dict[str, runtime.Any]]) -> runtime.Image.Image:
    source = image.copy().convert('RGB')
    side_width = 430
    canvas = runtime.Image.new('RGB', (source.width + side_width, source.height), (255, 255, 255))
    canvas.paste(source, (0, 0))
    draw = runtime.ImageDraw.Draw(canvas)
    font = runtime.load_debug_font(15)
    draw.rectangle([source.width, 0, canvas.width - 1, canvas.height - 1], fill=(255, 255, 255), outline=(220, 220, 220))
    draw.text((source.width + 16, 16), 'OCR boxes', fill=(40, 40, 40), font=font)
    for index, item in enumerate(items, start=1):
        box = item.get('box') if isinstance(item, dict) else None
        if not isinstance(box, dict):
            continue
        left = float(box.get('left') or 0)
        top = float(box.get('top') or 0)
        width = float(box.get('width') or 0)
        height = float(box.get('height') or 0)
        if width <= 0 or height <= 0:
            continue
        right = left + width
        bottom = top + height
        draw.rectangle([left, top, right, bottom], outline=(255, 0, 0), width=3)
        draw.rectangle([left, max(0, top - 20), left + 28, max(18, top - 2)], fill=(255, 255, 255), outline=(255, 0, 0))
        draw.text((left + 3, max(0, top - 20)), str(index), fill=(255, 0, 0), font=font)
        label_top = 48 + (index - 1) * 48
        if label_top + 42 < canvas.height:
            label = f"{index}. {float(item.get('score') or 0.0):.2f}"
            draw.text((source.width + 16, label_top), label, fill=(255, 0, 0), font=font)
            draw.text((source.width + 74, label_top), str(item.get('text') or '')[:34], fill=(20, 20, 20), font=font)
    return canvas

runtime.draw_debug_boxes = draw_debug_boxes

def load_debug_font(size: int) -> runtime.ImageFont.ImageFont:
    for candidate in ['C:\\Windows\\Fonts\\malgun.ttf', 'C:\\Windows\\Fonts\\malgunbd.ttf', 'C:\\Windows\\Fonts\\GOTHIC.TTF']:
        if runtime.Path(candidate).exists():
            return runtime.ImageFont.truetype(candidate, size)
    return runtime.ImageFont.load_default()

runtime.load_debug_font = load_debug_font
