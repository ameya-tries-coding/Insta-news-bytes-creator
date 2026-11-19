"""Turn stories.json into 1080x1920 Instagram story PNGs on the Fyntrest Bytes background.

Usage:  python make_stories.py                 -> out/<date>/<date>-<story-name>.png
        python make_stories.py --debug         -> also draws the no-go zones (for checking layout)
        python make_stories.py --file other.json

stories.json is a list of:
  { "url": article link (headline gets screenshotted from it),
    "tag": "GLOBAL", "source": "BBC News", "date": "17 Nov",
    "hook": "Big line, <em>highlight</em> allowed",
    "body": "Two or three short sentences of context.",
    "takeaway": "What this means for a student / young earner.",
    "image": optional. Leave out for no photo (the default layout: screenshot + text).
             "article" uses the article's own main photo; an image URL or a local file
             path uses that photo.
    "focus": optional CSS object-position for the photo crop, e.g. "center 20%" to keep a face in frame }
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

from shot import capture, download_photo, open_browser

ROOT = Path(__file__).resolve().parent


def slug(text, limit=50):
    text = re.sub(r"<[^>]+>", "", text).lower().replace("'", "").replace("’", "")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:limit].rsplit("-", 1)[0] if len(text) > limit else text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="stories.json")
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--reshoot", action="store_true", help="re-take article screenshots")
    args = ap.parse_args()

    stories = json.loads((ROOT / args.file).read_text(encoding="utf-8"))
    out_dir = ROOT / "out" / date.today().isoformat()
    out_dir.mkdir(parents=True, exist_ok=True)
    shots = ROOT / "out" / "shots"

    with sync_playwright() as p:
        browser, page = open_browser(p)
        for s in stories:
            name = slug(s.get("source", "") + "-" + s["url"].rstrip("/").split("/")[-1])
            want = s.get("image") or None
            # Beside a photo the card is narrower, so capture a narrower page: the headline
            # wraps onto more lines and stays readable.
            head = shots / (f"{name}_narrow.png" if want else f"{name}.png")
            cached_photo = next(iter(sorted(shots.glob(f"{head.stem}_photo.*"))), None)
            if args.reshoot or not head.exists() or (want == "article" and cached_photo is None):
                try:
                    got = capture(s["url"], head, page, photo=(want == "article"), width=(300 if want else 412))
                    cached_photo = Path(got["photo"]) if got["photo"] else None
                    print(f"  captured {s['source']}{' + photo' if cached_photo else ''}", file=sys.stderr)
                except Exception as e:
                    print(f"  screenshot failed for {s['url']}: {e}", file=sys.stderr)
            s["headline"] = head.relative_to(ROOT).as_posix() if head.exists() else ""
            s["site"] = urlparse(s["url"]).netloc.removeprefix("www.")

            photo = None
            if want == "article":
                photo = cached_photo
            elif isinstance(want, str) and want.startswith("http"):
                got = download_photo(page, want, shots / f"{name}_custom")
                photo = Path(got) if got else None
            elif isinstance(want, str) and want:
                photo = (ROOT / want).resolve()
            s["photo"] = photo.relative_to(ROOT).as_posix() if photo and photo.exists() else None
        browser.close()

        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
        for i, s in enumerate(stories, 1):
            s["debug"] = args.debug
            page.add_init_script(f"window.__STORY__ = {json.dumps(s)};")
            page.goto((ROOT / "template.html").as_uri())
            check = page.evaluate("window.__fit()")
            fits = check["fits"]
            if not check["fonts"]:
                print("  WARNING: fonts did not load (offline?), fallback fonts used", file=sys.stderr)
            # Named after the news, e.g. 2026-11-17-uk-firms-cant-afford-to-hire-under-25s.png
            suffix = "-zones" if args.debug else ""
            out = out_dir / f"{date.today().isoformat()}-{slug(s['hook'], 60)}{suffix}.png"
            page.screenshot(path=str(out))
            print(f"{out.relative_to(ROOT)}{'' if fits else '  (WARNING: text overflows, shorten it)'}")
            page.close()
            page = browser.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
        browser.close()


if __name__ == "__main__":
    main()
