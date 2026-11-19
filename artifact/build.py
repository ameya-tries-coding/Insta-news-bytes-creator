"""Inline the background and sample images into the story-maker page."""
import base64
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def uri(path, mime):
    return f"data:{mime};base64," + base64.b64encode(Path(path).read_bytes()).decode()


src = (ROOT / "src.html").read_text(encoding="utf-8")
src = src.replace("{{BG}}", uri(ROOT.parent / "assets" / "background.webp", "image/webp"))
src = src.replace("{{SAMPLE_HEAD}}", uri(ROOT / "sample-headline.webp", "image/webp"))
src = src.replace("{{SAMPLE_PHOTO}}", uri(ROOT / "sample-photo.webp", "image/webp"))
(ROOT / "fyntrest-bytes-maker.html").write_text(src, encoding="utf-8")
print("built", (ROOT / "fyntrest-bytes-maker.html").stat().st_size, "bytes")
