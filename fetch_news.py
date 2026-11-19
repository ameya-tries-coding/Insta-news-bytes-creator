"""Fetch recent finance headlines from free public RSS feeds (no API keys).

Usage:  python fetch_news.py            -> writes out/news.json
        python fetch_news.py --hours 36 -> only items from the last 36 hours
"""
import argparse
import email.utils
import html
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

FEEDS = {
    "Economic Times Markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    "Economic Times Wealth": "https://economictimes.indiatimes.com/wealth/rssfeeds/837555174.cms",
    "Mint Markets": "https://www.livemint.com/rss/markets",
    "Mint Money": "https://www.livemint.com/rss/money",
    "Moneycontrol": "https://www.moneycontrol.com/rss/latestnews.xml",
    "BBC Business": "https://feeds.bbci.co.uk/news/business/rss.xml",
    "CNBC Finance": "https://www.cnbc.com/id/10000664/device/rss/rss.html",
    "CNBC World": "https://www.cnbc.com/id/100727362/device/rss/rss.html",
}

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"


def clean(text):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def parse_date(s):
    if not s:
        return None
    try:
        d = email.utils.parsedate_to_datetime(s)
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def fetch(name, url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        root = ET.fromstring(r.read())
    items = []
    for it in root.iter("item"):
        img = None
        for child in it:
            tag = child.tag.split("}")[-1]
            if tag in ("content", "thumbnail") and child.get("url"):
                img = img or child.get("url")
            if tag == "enclosure" and "image" in (child.get("type") or ""):
                img = img or child.get("url")
        items.append({
            "source": name,
            "title": clean(it.findtext("title")),
            "summary": clean(it.findtext("description"))[:400],
            "link": (it.findtext("link") or "").strip(),
            "published": parse_date(it.findtext("pubDate")),
            "image": img,
        })
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=30)
    ap.add_argument("--out", default="out/news.json")
    args = ap.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours)
    seen, items = set(), []
    for name, url in FEEDS.items():
        try:
            got = fetch(name, url)
            print(f"  {name}: {len(got)} items", file=sys.stderr)
        except Exception as e:
            print(f"  {name}: FAILED ({e})", file=sys.stderr)
            continue
        for it in got:
            key = it["title"].lower()[:80]
            if not it["title"] or key in seen:
                continue
            if it["published"] and it["published"] < cutoff:
                continue
            seen.add(key)
            items.append(it)

    items.sort(key=lambda i: i["published"] or cutoff, reverse=True)
    for i, it in enumerate(items, 1):
        it["id"] = i
        it["published"] = it["published"].isoformat() if it["published"] else None

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(items)} headlines -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
