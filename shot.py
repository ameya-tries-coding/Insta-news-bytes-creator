"""Screenshot just the headline of a news article (text only, no photos),
phone-sized, using the Microsoft Edge already installed on Windows.

Usage:  python shot.py URL out/shots/name.png
"""
import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# Removes cookie/consent/subscribe popups, bottom bars and dimming overlays.
CLEAN_JS = r"""
() => {
  const vh = innerHeight;
  const junk = /cookie|consent|privacy|gdpr|subscribe|sign ?in|log ?in|notification|download (the|our) app|allow|accept|newsletter|versant|advert/i;
  for (const el of [...document.querySelectorAll('body *')]) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    const big = r.height > vh * 0.35;
    const low = r.top > vh * 0.45;
    const header = r.top <= 5 && r.height < 140 && !junk.test(el.innerText || '');
    if (header) { el.style.position = 'relative'; continue; }
    if (big || low || junk.test(el.innerText || '') || junk.test(el.id + ' ' + el.className)) el.remove();
  }
  document.querySelectorAll('iframe, [id*="google_ads"], [class*="ad-slot"], [class*="adSlot"]').forEach(e => e.remove());
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('filter', 'none', 'important');
  }
  document.querySelectorAll('body > *').forEach(e => { e.style.filter = 'none'; });
  scrollTo(0, 0);
}
"""

# Hides every picture, icon, video and background image so the screenshot is text only.
NO_IMAGES_JS = r"""
() => {
  document.querySelectorAll('img, picture, video, svg, canvas, iframe, figure').forEach(e => e.style.setProperty('visibility', 'hidden', 'important'));
  for (const el of document.querySelectorAll('h1, h1 *')) el.style.setProperty('background-image', 'none', 'important');
}
"""

# Finds the headline in page coordinates.
FIND_JS = r"""
() => {
  const h1 = [...document.querySelectorAll('h1')].find(h => h.getBoundingClientRect().height > 20 && h.innerText.trim().length > 15);
  if (!h1) return null;
  document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
  h1.scrollIntoView({ block: 'center', behavior: 'instant' });
  h1.setAttribute('data-story-headline', '1');
  // Remove anything drawn on top of the headline (late popups, dimming layers).
  let hb = h1.getBoundingClientRect();
  for (const [fx, fy] of [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.5, 0.15], [0.5, 0.85]]) {
    const stack = document.elementsFromPoint(hb.left + hb.width * fx, hb.top + hb.height * fy);
    if (!stack.some(el => el === h1 || h1.contains(el))) continue;  // point missed the headline
    for (const el of stack) {
      if (el === h1 || h1.contains(el) || el.contains(h1)) break;  // reached the headline or its page
      el.remove();
    }
  }
  hb = h1.getBoundingClientRect();
  // Tight crop so neighbouring lines (kicker, dateline) are not half-cut; the card adds its own padding.
  const pad = 3;
  // Viewport coordinates: the headline is scrolled into view, so no full-page render is needed.
  const head = { x: Math.max(0, hb.left - 12), y: Math.max(0, hb.top - pad), width: Math.min(innerWidth, hb.width + 24), height: hb.height + pad * 2 };
  return { head, title: h1.innerText.trim() };
}
"""


# Fresh viewport rectangle of the marked headline (small padding; the card adds its own).
RECT_JS = r"""
() => {
  const h1 = document.querySelector('[data-story-headline]');
  if (!h1) return null;
  const r = h1.getBoundingClientRect();
  return { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 3), width: Math.min(innerWidth, r.width + 24), height: r.height + 6 };
}
"""


# The article's main photo, as the publisher declares it for link previews.
PHOTO_JS = r"""
() => {
  const pick = sel => document.querySelector(sel)?.content;
  return pick('meta[property="og:image"]') || pick('meta[name="twitter:image"]') || pick('meta[property="twitter:image"]') || null;
}
"""

EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/avif": ".avif"}


def download_photo(page, photo_url, out_stem):
    """Downloads an image URL next to out_stem (extension from its type). Returns the path or None."""
    resp = page.request.get(photo_url, timeout=30000)
    kind = (resp.headers.get("content-type") or "").split(";")[0].strip()
    if not resp.ok or kind not in EXT:
        return None
    path = Path(str(out_stem) + EXT[kind])
    path.write_bytes(resp.body())
    return str(path)


def capture(url, out, page, photo=True, width=412):
    """Saves a text-only screenshot of the article headline to OUT and,
    if photo is True, the article's main photo to OUT_photo.<ext>.
    Returns {"headline": path, "photo": path or None}."""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    page.set_viewport_size({"width": width, "height": 915})
    page.goto(url, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(3500)
    for _ in range(2):  # popups often arrive late
        page.evaluate(CLEAN_JS)
        page.wait_for_timeout(800)
    photo_url = page.evaluate(PHOTO_JS) if photo else None
    page.evaluate(NO_IMAGES_JS)
    found = page.evaluate(FIND_JS)
    if not found:
        raise RuntimeError(f"No headline found on {url}")
    page.wait_for_timeout(500)
    # Re-measure once the page has settled after scrolling, then clip from the visible viewport.
    clip = page.evaluate(RECT_JS)
    page.screenshot(path=str(out), clip=clip or found["head"], timeout=60000)
    result = {"headline": str(out), "photo": None}
    if photo_url:
        try:
            result["photo"] = download_photo(page, photo_url, out.with_name(out.stem + "_photo"))
        except Exception:
            pass
    return result


def open_browser(p):
    browser = p.chromium.launch(channel="msedge", headless=True)
    ctx = browser.new_context(
        viewport={"width": 412, "height": 915},
        device_scale_factor=2.5,
        is_mobile=True,
        has_touch=True,
        user_agent=("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"),
        locale="en-IN",
    )
    return browser, ctx.new_page()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("out")
    args = ap.parse_args()
    with sync_playwright() as p:
        browser, page = open_browser(p)
        try:
            print(capture(args.url, args.out, page), file=sys.stderr)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
