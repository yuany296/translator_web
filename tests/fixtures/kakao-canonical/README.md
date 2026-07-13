# Kakao canonical 合成夹具

本目录只包含程序生成的匿名素材，不来自任何漫画或用户文件。

- `page-a.png`：页内独立对白、页面底部前半句与低置信度噪声。
- `page-b.png`：页面顶部后半句与另一条页内独立对白。
- `ocr-golden.json`：page/seam observations、filtered observation、edge signals、预期 canonical 与 coverage ledger。
- `generate_fixtures.py`：确定性重建 PNG 和 golden；默认寻找 Malgun Gothic/Noto Sans CJK，也可通过 `KAKAO_FIXTURE_FONT` 指定韩文字体。

重建命令：

```powershell
python tests/fixtures/kakao-canonical/generate_fixtures.py
```
