from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-ocr-service"))
sys.path.insert(0, str(ROOT / "tools"))

from ocr_debug_common import count_hangul  # noqa: E402


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


@dataclass(frozen=True)
class ParamProfile:
    name: str
    text_det_thresh: float
    text_det_box_thresh: float
    text_det_unclip_ratio: float
    text_rec_score_thresh: float = 0.0

    def as_params(self) -> dict[str, float]:
        return {
            "text_det_thresh": self.text_det_thresh,
            "text_det_box_thresh": self.text_det_box_thresh,
            "text_det_unclip_ratio": self.text_det_unclip_ratio,
            "text_rec_score_thresh": self.text_rec_score_thresh,
        }

    def label(self) -> str:
        return (
            f"det={self.text_det_thresh:g}, box={self.text_det_box_thresh:g}, "
            f"unclip={self.text_det_unclip_ratio:g}, rec={self.text_rec_score_thresh:g}"
        )


PROFILES = [
    ParamProfile("current", 0.30, 0.60, 1.20),
    ParamProfile("balanced", 0.20, 0.35, 1.50),
    ParamProfile("recall", 0.15, 0.30, 2.00),
    ParamProfile("wide", 0.10, 0.25, 2.50),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare local OCR service parameter profiles on the same images.")
    parser.add_argument("--input", default="tests/fixtures/ocr", help="Image file or folder.")
    parser.add_argument("--out", default="debug_param_compare", help="Output folder.")
    parser.add_argument("--lang", default="korean", choices=["auto", "korean", "japan"])
    parser.add_argument("--mode", default="enhanced", choices=["fast", "enhanced"])
    parser.add_argument(
        "--reuse-existing",
        action="store_true",
        help="Reuse existing OCR JSON files in --out and rebuild visuals/reports without running OCR.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    images = collect_images(Path(args.input))
    if not images:
        print(f"[FAIL] no images found under {args.input}", file=sys.stderr)
        return 1

    rows: list[dict[str, Any]] = []
    for image_path in images:
        print(f"[IMAGE] {image_path}")
        with Image.open(image_path) as image:
            width, height = image.size
        for profile in PROFILES:
            if args.reuse_existing:
                result = load_existing_json(out_dir, profile, image_path)
            else:
                result = run_profile_ocr(image_path, profile, args)
            row = summarize_result(image_path, profile, result, width, height)
            row["visual"] = str(save_visual(image_path, result.get("items", []), out_dir, profile, row))
            row["json"] = str(json_path_for(out_dir, profile, image_path))
            if not args.reuse_existing:
                save_json(out_dir, result, profile, image_path)
            rows.append(row)
            print(
                "[{mode}] {profile} boxes={boxes} chars={chars} avg={avg:.4f} visual={visual}".format(
                    mode="REUSE" if args.reuse_existing else "RUN",
                    profile=profile.name,
                    boxes=row["boxes"],
                    chars=row["script_chars"],
                    avg=row["avg_score"],
                    visual=row["visual"],
                )
            )

    contact_sheets = write_contact_sheets(out_dir, rows)
    html_path = write_html_report(out_dir, rows, args, contact_sheets)
    report_path = write_report(out_dir, rows, args, contact_sheets, html_path)
    print(f"[OUTPUT] {report_path.resolve()}")
    print(f"[OUTPUT] {html_path.resolve()}")
    return 0


def collect_images(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix.lower() in IMAGE_EXTS else []
    return sorted(item for item in path.rglob("*") if item.suffix.lower() in IMAGE_EXTS)


def run_profile_ocr(image_path: Path, profile: ParamProfile, args: argparse.Namespace) -> dict[str, Any]:
    import server

    debug_id = f"compare-{image_path.stem}-{profile.name}"
    return server.run_ocr(
        image_path.read_bytes(),
        args.lang,
        args.mode,
        profile.as_params(),
        True,
        debug_id,
    )


def load_existing_json(out_dir: Path, profile: ParamProfile, image_path: Path) -> dict[str, Any]:
    path = json_path_for(out_dir, profile, image_path)
    if not path.exists():
        raise FileNotFoundError(f"Missing existing OCR JSON: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def json_path_for(out_dir: Path, profile: ParamProfile, image_path: Path) -> Path:
    return out_dir / f"{image_path.stem}__{profile.name}.json"


def summarize_result(
    image_path: Path,
    profile: ParamProfile,
    result: dict[str, Any],
    width: int,
    height: int,
) -> dict[str, Any]:
    items = [item for item in result.get("items", []) if isinstance(item, dict)]
    scores = [float(item.get("score") or 0.0) for item in items]
    text = "".join(str(item.get("text") or "") for item in items)
    return {
        "image": str(image_path),
        "image_name": image_path.name,
        "profile": profile.name,
        "params": profile.label(),
        "boxes": len(items),
        "script_chars": count_hangul(text),
        "avg_score": sum(scores) / len(scores) if scores else 0.0,
        "raw_items": int(result.get("counts", {}).get("paddle_raw_items", 0)),
        "filtered_items": int(result.get("counts", {}).get("filtered_items", 0)),
        "merged_blocks": int(result.get("counts", {}).get("merged_blocks", 0)),
        "image_width": width,
        "image_height": height,
        "preview_text": " / ".join(str(item.get("text") or "").strip() for item in items[:8]),
    }


def save_visual(
    image_path: Path,
    items: list[dict[str, Any]],
    out_dir: Path,
    profile: ParamProfile,
    row: dict[str, Any],
) -> Path:
    image = Image.open(image_path).convert("RGB")
    side_width = 520
    canvas = Image.new("RGB", (image.width + side_width, max(image.height, 240)), "white")
    canvas.paste(image, (0, 0))
    draw = ImageDraw.Draw(canvas)
    font = load_font(16)
    small_font = load_font(13)
    draw.rectangle([image.width, 0, canvas.width - 1, canvas.height - 1], fill="white", outline=(220, 220, 220))
    draw.text((image.width + 16, 16), f"{profile.name}: {profile.label()}", fill=(30, 30, 30), font=font)
    draw.text(
        (image.width + 16, 42),
        f"boxes={row['boxes']} chars={row['script_chars']} avg={row['avg_score']:.3f}",
        fill=(70, 70, 70),
        font=small_font,
    )
    for index, item in enumerate(items, start=1):
        box = item.get("box") if isinstance(item, dict) else None
        if not isinstance(box, dict):
            continue
        left = float(box.get("left") or 0.0)
        top = float(box.get("top") or 0.0)
        width = float(box.get("width") or 0.0)
        height = float(box.get("height") or 0.0)
        if width <= 0 or height <= 0:
            continue
        right = left + width
        bottom = top + height
        color = box_color(index)
        draw.rectangle([left, top, right, bottom], outline=color, width=3)
        draw.rectangle([left, max(0, top - 18), left + 26, max(16, top - 2)], fill="white", outline=color)
        draw.text((left + 4, max(0, top - 18)), str(index), fill=color, font=small_font)
        label_top = 76 + (index - 1) * 44
        if label_top + 36 < canvas.height:
            text = str(item.get("text") or "").replace("\n", " ")[:38]
            draw.text((image.width + 16, label_top), f"{index}. {float(item.get('score') or 0):.2f}", fill=color, font=small_font)
            draw.text((image.width + 86, label_top), text, fill=(20, 20, 20), font=small_font)

    output = out_dir / f"{image_path.stem}__{profile.name}.png"
    canvas.save(output)
    return output


def save_json(out_dir: Path, result: dict[str, Any], profile: ParamProfile, image_path: Path) -> Path:
    output = out_dir / f"{image_path.stem}__{profile.name}.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return output


def write_contact_sheets(out_dir: Path, rows: list[dict[str, Any]]) -> dict[str, str]:
    output_dir = out_dir / "contact_sheets"
    output_dir.mkdir(parents=True, exist_ok=True)
    by_image = group_rows_by_image(rows)
    outputs: dict[str, str] = {}
    for image_name, image_rows in by_image.items():
        panels = []
        for profile in PROFILES:
            row = next((candidate for candidate in image_rows if candidate["profile"] == profile.name), None)
            if row is None:
                continue
            panel = Image.open(row["visual"]).convert("RGB")
            panel.thumbnail((760, 440), Image.Resampling.LANCZOS)
            panels.append((row, panel.copy()))
        if not panels:
            continue

        cell_width = max(panel.width for _, panel in panels)
        cell_height = max(panel.height for _, panel in panels)
        gap = 20
        header_height = 44
        width = cell_width * 2 + gap * 3
        height = header_height + cell_height * 2 + gap * 3
        sheet = Image.new("RGB", (width, height), "white")
        draw = ImageDraw.Draw(sheet)
        font = load_font(18)
        small_font = load_font(13)
        draw.text((gap, 12), image_name, fill=(20, 20, 20), font=font)
        for index, (row, panel) in enumerate(panels):
            col = index % 2
            line = index // 2
            left = gap + col * (cell_width + gap)
            top = header_height + gap + line * (cell_height + gap)
            draw.rectangle(
                [left - 1, top - 1, left + cell_width + 1, top + cell_height + 1],
                outline=(210, 210, 210),
            )
            sheet.paste(panel, (left, top))
            label = (
                f"{row['profile']} | boxes={row['boxes']} chars={row['script_chars']} "
                f"avg={row['avg_score']:.3f}"
            )
            draw.rectangle([left, top, left + cell_width, top + 22], fill=(255, 255, 255))
            draw.text((left + 8, top + 3), label, fill=(20, 20, 20), font=small_font)
        output = output_dir / f"{Path(image_name).stem}__compare.png"
        sheet.save(output)
        outputs[image_name] = str(output)
    return outputs


def write_html_report(
    out_dir: Path,
    rows: list[dict[str, Any]],
    args: argparse.Namespace,
    contact_sheets: dict[str, str],
) -> Path:
    report = out_dir / "decision.html"
    by_image = group_rows_by_image(rows)
    lines = [
        "<!doctype html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="utf-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
        "<title>OCR parameter comparison</title>",
        "<style>",
        "body{font-family:Arial,sans-serif;margin:24px;background:#f7f7f8;color:#1f2937}",
        "h1{font-size:24px;margin:0 0 8px}",
        "h2{font-size:18px;margin:28px 0 12px}",
        ".note{color:#4b5563;margin:0 0 18px}",
        ".summary{position:sticky;top:0;z-index:2;background:#ffffff;border:1px solid #d1d5db;padding:12px;margin:16px 0}",
        ".summary strong{display:inline-block;min-width:86px}",
        ".summary-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}",
        ".summary-pill{background:#eef2f7;border:1px solid #d1d5db;padding:6px 10px}",
        ".summary-actions{display:flex;gap:8px;margin:10px 0}",
        ".summary button{border:1px solid #94a3b8;background:#f8fafc;padding:7px 10px;cursor:pointer}",
        ".summary textarea{box-sizing:border-box;width:100%;min-height:92px;border:1px solid #cbd5e1;padding:8px;font-family:Consolas,monospace;font-size:12px}",
        ".chooser{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}",
        ".chooser label{background:white;border:1px solid #cbd5e1;padding:7px 10px;cursor:pointer}",
        ".chooser label:has(input:checked){background:#dbeafe;border-color:#2563eb;color:#1d4ed8}",
        ".chooser input{margin-right:6px}",
        "table{border-collapse:collapse;width:100%;background:white;margin:12px 0 24px}",
        "th,td{border:1px solid #d1d5db;padding:8px;text-align:left;font-size:13px}",
        "th{background:#eef2f7}",
        ".sheet{display:block;width:100%;max-width:1600px;border:1px solid #d1d5db;background:white}",
        ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px}",
        ".card{background:white;border:1px solid #d1d5db;padding:12px}",
        ".card img{width:100%;height:auto;border:1px solid #e5e7eb}",
        "code{background:#eef2f7;padding:2px 4px;border-radius:3px}",
        "</style>",
        "</head>",
        "<body>",
        "<h1>OCR parameter comparison</h1>",
        f'<p class="note">Input: <code>{escape_html(args.input)}</code> | lang/mode: '
        f"<code>{escape_html(args.lang)}</code> / <code>{escape_html(args.mode)}</code></p>",
        '<div class="summary">',
        "<strong>Your picks</strong>",
        '<span id="pick-status">No picks yet.</span>',
        '<div id="pick-summary" class="summary-grid"></div>',
        '<div class="summary-actions"><button type="button" id="copy-picks">Copy picks</button>'
        '<button type="button" id="clear-picks">Clear picks</button></div>',
        '<textarea id="pick-output" readonly placeholder="Pick one profile per image; a copyable summary appears here."></textarea>',
        "</div>",
        "<h2>Profiles</h2>",
        "<table><thead><tr><th>profile</th><th>params</th></tr></thead><tbody>",
    ]
    for profile in PROFILES:
        lines.append(f"<tr><td>{profile.name}</td><td>{profile.label()}</td></tr>")
    lines.extend(["</tbody></table>", "<h2>Metric hints</h2>"])
    lines.append(
        "<p class=\"note\">These hints only rank the OCR output by script character count, then average score. "
        "Use the images below for the real decision.</p>"
    )
    lines.append("<table><thead><tr><th>image</th><th>metric hint</th><th>reason</th></tr></thead><tbody>")
    for image_name, image_rows in by_image.items():
        hint = metric_hint(image_rows)
        lines.append(
            f"<tr><td>{escape_html(image_name)}</td><td>{escape_html(hint['profile'])}</td>"
            f"<td>chars={hint['script_chars']}, avg={hint['avg_score']:.4f}</td></tr>"
        )
    lines.extend(["</tbody></table>", "<h2>Quick decision sheets</h2>"])
    for index, (image_name, sheet) in enumerate(contact_sheets.items(), start=1):
        rel = Path(sheet).relative_to(out_dir).as_posix()
        lines.append(f"<h3>{escape_html(image_name)}</h3>")
        lines.append('<div class="chooser">')
        for profile in PROFILES:
            lines.append(
                f'<label><input type="radio" name="pick-{index}" value="{profile.name}" '
                f'data-image="{escape_html(image_name)}" data-profile="{profile.name}" />'
                f"{profile.name}</label>"
            )
        lines.append("</div>")
        lines.append(f'<a href="{escape_html(rel)}"><img class="sheet" src="{escape_html(rel)}" /></a>')
    lines.extend(
        [
            "<h2>Detailed metrics</h2>",
            "<table><thead><tr><th>image</th><th>profile</th><th>boxes</th><th>script chars</th>"
            "<th>avg score</th><th>raw</th><th>filtered</th><th>merged</th><th>visual</th></tr></thead><tbody>",
        ]
    )
    for image_rows in by_image.values():
        for row in image_rows:
            visual = Path(row["visual"]).relative_to(out_dir).as_posix()
            lines.append(
                f"<tr><td>{escape_html(row['image_name'])}</td><td>{escape_html(row['profile'])}</td>"
                f"<td>{row['boxes']}</td><td>{row['script_chars']}</td><td>{row['avg_score']:.4f}</td>"
                f"<td>{row['raw_items']}</td><td>{row['filtered_items']}</td><td>{row['merged_blocks']}</td>"
                f'<td><a href="{escape_html(visual)}">{escape_html(Path(visual).name)}</a></td></tr>'
            )
    lines.extend(
        [
            "</tbody></table>",
            "<script>",
            "const storageKey = 'ocr-param-picks-v1';",
            "const imageNames = Array.from(new Set(Array.from(document.querySelectorAll('input[data-image]')).map((input) => input.dataset.image)));",
            "const profiles = Array.from(document.querySelectorAll('input[data-profile]')).map((input) => input.value)",
            "  .filter((value, index, list) => list.indexOf(value) === index);",
            "function loadPicks(){try{return JSON.parse(localStorage.getItem(storageKey) || '{}')}catch{return {}}}",
            "function savePicks(picks){localStorage.setItem(storageKey, JSON.stringify(picks));}",
            "function buildPickText(picks, counts, leader){",
            "  const lines = ['OCR parameter picks:', `overall=${leader || 'undecided'}`];",
            "  for (const image of imageNames) lines.push(`${image}=${picks[image] || 'undecided'}`);",
            "  lines.push('counts=' + profiles.map((profile) => `${profile}:${counts[profile] || 0}`).join(', '));",
            "  return lines.join('\\n');",
            "}",
            "function updateSummary(){",
            "  const picks = loadPicks();",
            "  const counts = Object.fromEntries(profiles.map((profile) => [profile, 0]));",
            "  for (const value of Object.values(picks)) { if (counts[value] !== undefined) counts[value] += 1; }",
            "  const total = Object.keys(picks).length;",
            "  const leader = profiles.slice().sort((a, b) => counts[b] - counts[a])[0] || '';",
            "  document.getElementById('pick-status').textContent = total ? `${total}/${imageNames.length} image pick(s), leader: ${leader}` : 'No picks yet.';",
            "  document.getElementById('pick-summary').innerHTML = profiles.map((profile) => "
            "    `<span class=\"summary-pill\">${profile}: ${counts[profile]}</span>`).join('');",
            "  document.getElementById('pick-output').value = total ? buildPickText(picks, counts, leader) : '';",
            "}",
            "function restorePicks(){",
            "  const picks = loadPicks();",
            "  document.querySelectorAll('input[data-profile]').forEach((input) => {",
            "    input.checked = picks[input.dataset.image] === input.value;",
            "    input.addEventListener('change', () => {",
            "      const next = loadPicks();",
            "      next[input.dataset.image] = input.value;",
            "      savePicks(next);",
            "      updateSummary();",
            "    });",
            "  });",
            "  updateSummary();",
            "}",
            "document.getElementById('copy-picks').addEventListener('click', async () => {",
            "  const output = document.getElementById('pick-output');",
            "  output.select();",
            "  try { await navigator.clipboard.writeText(output.value); } catch { document.execCommand('copy'); }",
            "});",
            "document.getElementById('clear-picks').addEventListener('click', () => {",
            "  localStorage.removeItem(storageKey);",
            "  document.querySelectorAll('input[data-profile]').forEach((input) => { input.checked = false; });",
            "  updateSummary();",
            "});",
            "restorePicks();",
            "</script>",
            "</body>",
            "</html>",
        ]
    )
    report.write_text("\n".join(lines), encoding="utf-8")
    return report


def write_report(
    out_dir: Path,
    rows: list[dict[str, Any]],
    args: argparse.Namespace,
    contact_sheets: dict[str, str],
    html_path: Path,
) -> Path:
    report = out_dir / "report.md"
    lines = [
        "# OCR Parameter Comparison",
        "",
        "- Date: 2026-06-17",
        "- Runner: Codex",
        f"- Input: `{args.input}`",
        f"- Lang / mode: `{args.lang}` / `{args.mode}`",
        f"- HTML decision view: [{html_path.name}]({html_path.name})",
        "",
        "## Profiles",
        "",
        "| profile | params |",
        "| --- | --- |",
    ]
    for profile in PROFILES:
        lines.append(f"| {profile.name} | {profile.label()} |")
    lines.extend(
        [
            "",
            "## Quick Decision Sheets",
            "",
            "| image | contact sheet |",
            "| --- | --- |",
        ]
    )
    for image_name, sheet in contact_sheets.items():
        rel = Path(sheet).relative_to(out_dir).as_posix()
        lines.append(f"| {image_name} | [{Path(sheet).name}]({rel}) |")
    lines.extend(
        [
            "",
            "## Metrics",
            "",
            "| image | profile | boxes | script chars | avg score | raw | filtered | merged | visual |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
        ]
    )
    for row in rows:
        visual = Path(row["visual"]).name
        lines.append(
            f"| {row['image_name']} | {row['profile']} | {row['boxes']} | {row['script_chars']} | "
            f"{row['avg_score']:.4f} | {row['raw_items']} | {row['filtered_items']} | {row['merged_blocks']} | "
            f"[{visual}]({visual}) |"
        )
    lines.extend(["", "## Text Preview", ""])
    for row in rows:
        lines.append(f"### {row['image_name']} / {row['profile']}")
        lines.append("")
        lines.append(row["preview_text"] or "(empty)")
        lines.append("")
    report.write_text("\n".join(lines), encoding="utf-8")
    return report


def group_rows_by_image(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault(str(row["image_name"]), []).append(row)
    for image_rows in grouped.values():
        order = {profile.name: index for index, profile in enumerate(PROFILES)}
        image_rows.sort(key=lambda row: order.get(str(row["profile"]), 999))
    return grouped


def metric_hint(image_rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not image_rows:
        return {"profile": "n/a", "script_chars": 0, "avg_score": 0.0}
    return max(
        image_rows,
        key=lambda row: (
            int(row.get("script_chars") or 0),
            float(row.get("avg_score") or 0.0),
            int(row.get("boxes") or 0),
        ),
    )


def escape_html(value: Any) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def box_color(index: int) -> tuple[int, int, int]:
    colors = [
        (220, 38, 38),
        (37, 99, 235),
        (5, 150, 105),
        (217, 119, 6),
        (126, 34, 206),
        (8, 145, 178),
    ]
    return colors[(index - 1) % len(colors)]


def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in [
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\malgunbd.ttf",
        r"C:\Windows\Fonts\GOTHIC.TTF",
    ]:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


if __name__ == "__main__":
    raise SystemExit(main())
