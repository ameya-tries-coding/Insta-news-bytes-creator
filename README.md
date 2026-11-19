# Fyntrest Bytes

Turns a finance news article into a branded 1080×1920 Instagram story: a real screenshot of the article's headline, a short punchy line, two lines of context, and "What it means for you" for Indian students and young earners. All of it is drawn on the Fyntrest Bytes background, inside Instagram's safe zones.

There are three ways to make one, all free to run:

| | Who uses it | How |
|---|---|---|
| **Team web app** (`cloudflare/`) | Anyone on the team, on a phone | Paste a link or type a topic. Live at https://fyntrest-bytes.fyntrest-bytes.workers.dev |
| **Laptop tools** (repo root) | One person at a laptop, with Claude Code | Fetch the day's news, write `stories.json`, render the PNGs |
| **Claude Maker page** (`artifact/`) | Team members with Claude accounts | Upload a headline screenshot; Claude drafts the words in the page |

## Team web app (Cloudflare Workers, free plan)

```
phone ──POST /api/story {query}──▶ Worker (src/worker.js)
                                     ├─ topic? → search free publisher RSS feeds (ET, Mint, Business Standard, BBC, CNBC)
                                     ├─ headless Chromium (Cloudflare Browser Run) → accept cookie wall,
                                     │   strip popups/images, screenshot just the <h1>, read the article text
                                     └─ Workers AI (Llama 3.3 70B) → tag, source, hook, body, takeaway (JSON)
phone ◀── headline PNG (base64) + text ──┘
phone draws the story on <canvas> (public/index.html) → Share (Web Share API) / Download
```

The image is drawn on the phone, so editing the words re-renders instantly and costs no server time.

**Free-plan budget.** Browser Run on Workers Free allows 10 browser-minutes a day (resets 00:00 UTC = 5:30 am IST) and 1 new browser every 20 s. A story costs about 10–20 s, so roughly 30–50 stories a day for the whole team. The Worker closes the browser as soon as the screenshot is taken, waits for a free slot when two people start at once, checks the day's usage before launching, and the page shows "About N stories left today". Workers AI's free daily allowance covers far more stories than the browser does.

**Files**
- `src/worker.js`: API (`/api/story`, `/api/config`, `/api/status` for browser-usage diagnostics) and static assets
- `src/page-scripts.js`: page-cleaning and headline-finding scripts, generated from `shot.py` by `gen_scripts.py` so both versions capture headlines the same way
- `public/index.html`: the phone page and the story renderer
- `wrangler.jsonc`: bindings (`MYBROWSER`, `AI`, `ASSETS`)

**Deploy**
```
cd cloudflare
npm install
npx wrangler login          # browser OAuth; click Allow within ~2 minutes
npx wrangler deploy
npx wrangler secret put TEAM_PASSWORD   # optional: the page then asks for it
```
Optional `GEMINI_API_KEY` secret: only used if Workers AI fails, and only works if Gemini's free tier is available to that Google project (it was not for ours).

**Known limits**
- Google News and GDELT block Cloudflare's servers, so topic search uses publisher RSS feeds. Moneycontrol's feed also blocks Cloudflare.
- Cloudflare's browser runs in Europe (choosing the country is a paid feature), so some sites show cookie walls. The Worker clicks "Accept". If a screenshot still fails, or captures the wrong heading, the story shows the headline as a plain card instead.
- `wrangler dev` cannot start the local browser on Windows ("spawn UNKNOWN"), so the screenshot path can only be tested on the deployed Worker.

## Laptop tools (Python 3 + Playwright, uses the installed Microsoft Edge)

```
pip install playwright
python fetch_news.py                 # out/news.json: ~150-200 headlines from free RSS feeds
# write stories.json (Claude Code does this from news.json; see the format in make_stories.py)
python make_stories.py               # out/<date>/<date>-<story-name>.png
python make_stories.py --debug       # draws the no-go zones for checking layout
```
- `shot.py`: headline screenshot (and optional lead photo) with popups and images removed
- `template.html`: the story layout. Same geometry as the web app.
- Layout rules: by default, screenshot + text. A photo appears only when a story's `"image"` is set ("article", a URL, or a local path), placed to the right of the screenshot. A credit is required for Wikimedia Commons photos (`"credit"`).

## Claude Maker page

`artifact/src.html` is a single-page tool published as a Claude artifact. `python artifact/build.py` inlines the background and sample images into `artifact/fyntrest-bytes-maker.html`, which is then republished. It uses the viewer's own Claude account (`sample` capability) to read the uploaded screenshot and draft the text.

## Design

- Background: `assets/background.webp` (Fyntrest Bytes logo top-left, F mark bottom-left)
- Safe zone: x 64–1016, y ~380–1385 (clear of the logo, the F mark and Instagram's top/bottom UI)
- Fonts: Barlow Condensed ExtraBold for the hook, Google Sans SemiBold for everything else, accent #7b7cff
