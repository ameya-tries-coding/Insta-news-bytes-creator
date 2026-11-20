# Insta News Bytes Creator

Turn any finance news article into a ready-to-post Instagram story in seconds.

Pick from **Today's picks** (the stories an AI thinks matter most right now), search a topic like "RBI repo rate" and choose from the matching news, or paste any news link. You get a 1080×1920 story with:

- the article's news photo
- a short, punchy headline in plain words
- two lines of context
- **What it means for you**: a takeaway for students and young earners
- the source, credited at the bottom

It was built for **Fyntrest Bytes**, the finance-news story series by [Fyntrest](https://beacons.ai/fyntrest), a financial literacy brand for young people in India. The code works for any brand: swap in your own background, colours and wording.

**Everything runs on free tiers.** No paid APIs, no servers to pay for.

---

## Ways to use it

| | Best for | What you do |
|---|---|---|
| **Web app** (`cloudflare/`) | A team, on their phones | Tap one of Today's picks, or search a topic and tap a result, or paste a link. Then **Share** to Instagram |
| **Laptop tools** (repo root) | One person making a daily batch | Fetch the day's headlines, pick stories, render the images with a script |
| **Claude Maker page** (`artifact/`) | People who use Claude | Upload a screenshot of a headline; Claude writes the words inside the page |

---

## The web app

### How it works

1. **Find the article.**
   - **Today's picks:** every 3 hours the app reads the latest ~150 headlines and the AI chooses the 6 that matter most to students and young earners, each with a one-line reason. Picks are saved (Cloudflare KV) so every visitor sees them instantly.
   - **Search:** type a topic and pick from up to 10 matching recent stories, with photo, source and time. Repeats of the same story from different sites are filtered out.
   - News comes from free feeds: Economic Times, Mint, Business Standard, BusinessLine, NDTV Profit, Times of India, Hindustan Times, The Hindu, BBC and CNBC.
2. **Read it.** The server downloads the article page and picks out the title, summary, text and the photo the site uses for link previews.
3. **Write the words.** A free AI model (Llama 3.3 on Cloudflare Workers AI) writes the tag, headline, context and takeaway using only facts from the article.
4. **Draw the story.** Your phone draws the final image, so you can edit any word and see the change instantly. Then share it straight to Instagram or download it.

If a site blocks downloads, a headless browser reads the page instead. If an article has no usable photo, the story shows its headline as a clean card.

### Run your own copy (free)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and [Node.js](https://nodejs.org).

```bash
git clone https://github.com/ameya-tries-coding/Insta-news-bytes-creator.git
cd Insta-news-bytes-creator/cloudflare
npm install
npx wrangler login     # opens Cloudflare in your browser: click Allow within ~2 minutes
npx wrangler kv namespace create PICKS   # storage for Today's picks; put the printed id in wrangler.jsonc
npx wrangler deploy    # prints your app's link, e.g. https://your-app.your-name.workers.dev
```

Optional: ask for a password before anyone can make a story.

```bash
npx wrangler secret put TEAM_PASSWORD
```

### Free-tier limits

- **Stories:** normal stories use only a page download and the AI model. Cloudflare's free AI allowance covers well over a hundred stories a day.
- **Today's picks:** made at most every 3 hours (a Refresh tap reuses picks made in the last 10 minutes), so they cost very little of the AI allowance and about 8 of the 1,000 free daily KV saves.
- **Backup browser:** used only for sites that block downloads. The free plan gives 10 browser-minutes a day (resets at midnight UTC) and starts one new browser every 20 seconds. The app closes the browser as soon as it has read the page and tells you clearly when the allowance is used up.

---

## The laptop tools

Python scripts that use the Microsoft Edge (or Chromium) already on your computer. These make the original version of the story, with a screenshot of the article's headline instead of the news photo.

```bash
pip install playwright
python fetch_news.py            # saves ~150-200 recent headlines to out/news.json
# write stories.json: pick stories and write the words (see the format at the top of make_stories.py)
python make_stories.py          # renders out/<date>/<date>-<story-name>.png
python make_stories.py --debug  # same, with Instagram's no-go zones drawn on top
```

- `fetch_news.py`: free RSS feeds, no API keys. Edit the list at the top to change sources.
- `shot.py`: screenshots just the headline, with cookie popups, ads and images removed.
- `template.html`: the story layout.
- A photo can be added to any story with `"image"` in `stories.json`: `"article"` uses the article's own photo, or give a URL or file path. Add `"credit"` for photos that need attribution, such as Wikimedia Commons.

## The Claude Maker page

`artifact/src.html` is a single-page tool that runs as a [Claude](https://claude.ai) artifact. You upload a headline screenshot, Claude reads it and drafts the text, and you download the story. Run `python artifact/build.py` to bundle the images into one HTML file before publishing it.

---

## Make it yours

- **Background:** replace `assets/background.webp` and `cloudflare/public/background.webp` (1080×1920).
- **Safe area:** content stays inside x 64–1016 and y 380–1385, clear of the logo, the corner graphic and Instagram's own buttons. Change `ZTOP`, `ZBOT` and `ZX` in `cloudflare/public/index.html` (and `--zone-*` in `template.html`) to fit your design.
- **Fonts and colours:** Barlow Condensed ExtraBold for the headline, Google Sans SemiBold for the rest, accent `#7b7cff`. All set near the top of `cloudflare/public/index.html` and `template.html`.
- **Voice and audience:** the AI instructions are `PROMPT` (story text) and `PICKS_PROMPT` (Today's picks) in `cloudflare/src/worker.js`.
- **News sources:** `FEEDS` in `cloudflare/src/worker.js` and in `fetch_news.py`.

---

## Good to know

- **Check before posting.** The AI is told to use only facts from the article, but always read the words against the source.
- **Photos belong to the publishers.** Every story credits the source. Follow your own policy, and the publishers' terms, before reposting at scale.
- **Some sites refuse automated readers.** Google News, GDELT and Moneycontrol's feed block Cloudflare's servers, which is why topic search uses publisher feeds directly. Pasting a link works for most sites.
- **Testing locally:** `wrangler dev` can't start the backup browser on Windows ("spawn UNKNOWN"). The main download path works locally; the browser path only works once deployed.

## Project layout

```
cloudflare/          the web app (Cloudflare Worker + phone page)
  src/worker.js        finds and reads articles, writes the text
  public/index.html    the page and the story renderer
  wrangler.jsonc       Cloudflare settings
fetch_news.py        laptop: fetch headlines
shot.py              laptop: headline screenshots
make_stories.py      laptop: render stories from stories.json
template.html        laptop: story layout
artifact/            Claude Maker page
assets/              background image
```

## Brand assets

The Fyntrest name, logo and the Fyntrest Bytes background belong to Fyntrest. Please use your own branding if you build on this project.
