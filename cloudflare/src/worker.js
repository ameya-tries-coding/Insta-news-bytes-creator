// Fyntrest Bytes on Cloudflare Workers (free plan).
// POST /api/story {query} -> the article's news photo + story text. The phone draws the story image.
//
// How an article is read:
//   1. a plain download of the page (no browser): title, summary, text and its preview photo (og:image)
//   2. only if the site blocks that: Cloudflare's headless browser (free plan: 10 browser-minutes a day)
// Text is written by Cloudflare Workers AI (free plan, no key). Optional secrets
// (set with `npx wrangler secret put NAME`):
//   TEAM_PASSWORD   when set, the page asks for it
//   GEMINI_API_KEY  only used if Workers AI fails (Gemini's free tier must be available to your Google project)
// Variable (wrangler.jsonc "vars"): GEMINI_MODEL, default gemini-2.5-flash
import puppeteer from "@cloudflare/puppeteer";

const DAILY_SECONDS = 600;      // free plan: 10 browser-minutes a day (only used for sites that block downloads)
const DAILY_LIMIT_MSG = "This site needs the backup browser, and today's free browser time is used up. Try another link, or again after 5:30 am IST.";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_IMAGE_BYTES = 4_000_000;

// Read in the backup browser: same fields as readArticleHtml().
const ARTICLE_JS = `(() => {
  const meta = s => document.querySelector(s)?.content?.trim() || '';
  const h1 = [...document.querySelectorAll('h1')].find(h => h.innerText.trim().length > 15);
  const paras = [...document.querySelectorAll('article p, main p, p')]
    .map(p => p.innerText.trim()).filter(t => t.length > 80).slice(0, 12);
  return {
    title: (meta('meta[property="og:title"]') || h1?.innerText || document.title || '').trim(),
    description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
    site_name: meta('meta[property="og:site_name"]'),
    image: meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]') || meta('meta[property="twitter:image"]'),
    text: paras.join('\\n\\n').slice(0, 7000),
    url: location.href,
  };
})()`;

// Clicks the accept button of a cookie / consent wall, in the page or in its consent iframe.
const CONSENT_JS = `(() => {
  const want = /^(accept( all| all cookies| cookies)?|i accept|agree|i agree|yes,? i agree|allow all( cookies)?|ok|got it|continue|consent|accept and continue|yes,? i.?m happy)$/i;
  // Buttons only: links titled "Continue" are often "continue reading" links to other pages.
  for (const b of document.querySelectorAll('button, [role=button], input[type=button], input[type=submit]')) {
    const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    if (t && t.length < 40 && want.test(t)) { b.click(); return true; }
  }
  return false;
})()`;

async function acceptConsent(page) {
  for (const frame of page.frames()) {
    try { if (await frame.evaluate(CONSENT_JS)) return true; } catch { /* cross-origin or gone */ }
  }
  return false;
}

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config") return json({ password: !!env.TEAM_PASSWORD, ai: !!(env.AI || env.GEMINI_API_KEY) });
      if (url.pathname === "/api/status") {
        // Backup-browser allowance, for diagnostics (no secrets).
        const [limits, recent] = await Promise.all([
          puppeteer.limits(env.MYBROWSER).catch(e => ({ error: String(e) })),
          puppeteer.history(env.MYBROWSER).then(h => h.slice(0, 20)).catch(e => ({ error: String(e) })),
        ]);
        return json({ limits, recent });
      }
      const checkPassword = () => {
        if (env.TEAM_PASSWORD && request.headers.get("x-team-password") !== env.TEAM_PASSWORD) throw new UserError("Wrong team password.", 401);
      };
      if (url.pathname === "/api/search") {
        // Keyword -> list of matching recent news, for the person to choose from.
        checkPassword();
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) throw new UserError("Type a word or two to search for.");
        return json({ results: await feedSearch(q, 10) });
      }
      if (url.pathname === "/api/picks") {
        // Today's picks: the AI's choice of the best stories right now, saved for 3 hours.
        checkPassword();
        return json(await getPicks(env, url.searchParams.get("refresh") === "1"));
      }
      if (url.pathname === "/api/story" && request.method === "POST") {
        checkPassword();
        const { query = "", pick = null } = await request.json().catch(() => ({}));
        if (query.trim().length < 3) throw new UserError("Paste a news link or type a topic.");
        return json(await makeStory(query.trim(), env, pick));
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status);
      const msg = String(e?.message || e);
      console.log("ERROR", msg);
      if (/time limit exceeded|exceeded for today|daily/i.test(msg)) return json({ error: DAILY_LIMIT_MSG }, 429);
      if (/429|rate limit|too many/i.test(msg)) return json({ error: "This site needs the backup browser, which is busy. Try again in 20 seconds." }, 503);
      return json({ error: "Something went wrong making that story. Try again, or try another link." }, 500);
    }
  },
};

// ---------------------------------------------------------------- reading the article
// 1) Plain download: fast, free, no browser time.
async function readArticleHtml(link) {
  let r;
  try {
    r = await fetch(link, { redirect: "follow", headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-IN,en;q=0.9" } });
  } catch (e) { console.log("fetch failed", link, String(e)); return null; }
  if (!r.ok || !(r.headers.get("content-type") || "").includes("html")) { console.log("fetch", r.status, link.slice(0, 80)); return null; }
  const html = (await r.text()).slice(0, 1_500_000);
  const meta = (attr, name) => {
    const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, "i");
    const tag = (html.match(re) || [])[0] || "";
    return decode((tag.match(/content=["']([^"']*)["']/i) || [])[1] || "");
  };
  const title = meta("property", "og:title") || meta("name", "twitter:title") || decode(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ""));
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter(t => t.length > 80).slice(0, 12);
  let image = meta("property", "og:image") || meta("property", "og:image:url") || meta("name", "twitter:image") || meta("property", "twitter:image");
  if (!image) { const ld = html.match(/"image"\s*:\s*(?:\{[^}]*?"url"\s*:\s*)?\[?\s*"(https?:[^"]+)"/i); if (ld) image = ld[1].replace(/\\\//g, "/"); }
  let abs = "";
  try { abs = image ? new URL(image, r.url || link).href : ""; } catch { abs = ""; }
  return {
    title: title.trim(),
    description: meta("property", "og:description") || meta("name", "description"),
    site_name: meta("property", "og:site_name"),
    image: abs,
    text: paras.join("\n\n").slice(0, 7000),
    url: r.url || link,
  };
}

// 2) Backup browser, for sites that refuse plain downloads.
async function readArticleBrowser(link, env) {
  const browser = await getBrowser(env);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(1500);
    if (await acceptConsent(page)) await sleep(1500);
    return await page.evaluate(ARTICLE_JS);
  } finally {
    await browser.close().catch(() => {});  // stop the browser clock right away
  }
}

// The photo, sent to the phone as a data: URL (the phone's canvas can't load other sites' images directly).
async function fetchImage(src, referer) {
  if (!src) return null;
  try {
    const r = await fetch(src, { headers: { "user-agent": UA, referer: referer || "", accept: "image/avif,image/webp,image/jpeg,image/png,image/*" } });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!r.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) { console.log("image", r.status, type, src.slice(0, 80)); return null; }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 3000 || buf.length > MAX_IMAGE_BYTES) return null;  // tiny = icon or tracking pixel
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return `data:${type};base64,${btoa(bin)}`;
  } catch (e) { console.log("image failed", String(e)); return null; }
}

async function makeStory(query, env, pick = null) {
  const isLink = /^https?:\/\//i.test(query);
  // A news item chosen from the search list or Today's picks brings its feed details (title, photo...) as a fallback.
  const hint = pick && typeof pick === "object" ? {
    title: String(pick.title || "").slice(0, 300), source: String(pick.source || "").slice(0, 60),
    image: /^https?:\/\//i.test(pick.image || "") ? String(pick.image) : "", description: String(pick.description || "").slice(0, 600),
  } : { title: "", source: "", image: "", description: "" };
  const hits = isLink ? [{ link: query, ...hint }] : await googleNews(query);
  if (!hits.length) throw new UserError("No recent news found for that. Try different words or paste a link.", 404);

  let info = null, hit = hits[0];
  for (const h of hits.slice(0, 3)) {  // first result that downloads cleanly
    const got = await readArticleHtml(h.link);
    if (got && got.title) { info = got; hit = h; break; }
  }
  if (!info) {
    // Every plain download was refused: one try with the backup browser, else use the feed's own details.
    try { info = await readArticleBrowser(hit.link, env); }
    catch (e) {
      if (isLink) throw e;
      console.log("browser fallback failed", String(e));
    }
  }
  info = info || { title: hit.title, description: hit.description || "", site_name: hit.source, image: "", text: "", url: hit.link };
  info.title = info.title || hit.title;
  info.image = info.image || hit.image || "";
  info.description = info.description || hit.description || "";
  info.source_hint = hit.source;
  if (!info.title) throw new UserError("Couldn't read that article. Try another link.", 422);

  const [image, { copy, note }] = await Promise.all([fetchImage(info.image, info.url), writeCopy(info, env)]);
  const notes = [note, image ? "" : "No usable photo on this article, so the headline is shown as a card instead."].filter(Boolean);
  return {
    image,
    title: info.title,
    site: hostname(info.url),
    fields: { ...copy, date: istDate() },
    note: notes.join(" "),
  };
}

// ---------------------------------------------------------------- browser (backup only)
async function getBrowser(env) {
  // The free plan allows 1 new browser every 20 s: wait for the slot (up to 20 s) instead of failing.
  for (let attempt = 0; attempt < 4; attempt++) {
    let lim = null;
    try { lim = await puppeteer.limits(env.MYBROWSER); } catch { /* limits not available: just try */ }
    if (lim && typeof lim.usedBrowserTimeSeconds === "number" && lim.usedBrowserTimeSeconds >= DAILY_SECONDS - 5) {
      throw new UserError(DAILY_LIMIT_MSG, 429);
    }
    try {
      if (lim && lim.allowedBrowserAcquisitions === 0) {
        const wait = Math.min(Number(lim.timeUntilNextAllowedBrowserAcquisition) || 5000, 20_000);
        await sleep(wait + 300);
      }
    } catch { /* ignore */ }
    try {
      // (Choosing the browser's country, e.g. India, is not allowed on the free plan.)
      return await puppeteer.launch(env.MYBROWSER);
    } catch (e) {
      const msg = String(e?.message || e);
      console.log("launch failed", attempt, msg.slice(0, 200));
      if (/exceeded for today|time limit exceeded|daily/i.test(msg) || attempt === 3) throw e;
      await sleep(7000);  // 4 tries over ~21 s covers the "1 new browser every 20 s" rule
    }
  }
}

// ---------------------------------------------------------------- search
async function googleNews(query) {
  // Google News first (Indian edition), Bing News when Google returns nothing to Cloudflare's servers.
  const q = encodeURIComponent(query);
  const google = await rssItems(`https://news.google.com/rss/search?q=${q}+when:7d&hl=en-IN&gl=IN&ceid=IN:en`, { cookie: "CONSENT=YES+cb; SOCS=CAI" });
  if (google.length) return google;
  const feeds = await feedSearch(query);
  if (feeds.length) return feeds;
  const bing = await rssItems(`https://www.bing.com/news/search?q=${q}&format=rss&setmkt=en-IN&mkt=en-IN`);
  return bing.map(h => {
    // Bing wraps links as .../apiclick.aspx?...&url=<article>
    try { const real = new URL(h.link).searchParams.get("url"); if (real) h.link = real; } catch {}
    return h;
  });
}

// The free finance feeds the laptop version uses. Topic search = best keyword match among their latest headlines.
const FEEDS = {
  "Economic Times": ["https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "https://economictimes.indiatimes.com/wealth/rssfeeds/837555174.cms", "https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms"],
  "Mint": ["https://www.livemint.com/rss/markets", "https://www.livemint.com/rss/money", "https://www.livemint.com/rss/economy"],
  "Moneycontrol": ["https://www.moneycontrol.com/rss/latestnews.xml"],
  "Business Standard": ["https://www.business-standard.com/rss/home_page_top_stories.rss", "https://www.business-standard.com/rss/economy-102.rss", "https://www.business-standard.com/rss/finance-103.rss", "https://www.business-standard.com/rss/markets-106.rss"],
  "BusinessLine": ["https://www.thehindubusinessline.com/feeder/default.rss"],
  "NDTV Profit": ["https://feeds.feedburner.com/ndtvprofit-latest"],
  "Times of India": ["https://timesofindia.indiatimes.com/rssfeeds/1898055.cms"],
  "Hindustan Times": ["https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml"],
  "The Hindu": ["https://www.thehindu.com/business/feeder/default.rss"],
  "BBC News": ["https://feeds.bbci.co.uk/news/business/rss.xml"],
  "CNBC": ["https://www.cnbc.com/id/10000664/device/rss/rss.html", "https://www.cnbc.com/id/100727362/device/rss/rss.html"],
};
const STOP = new Set(["the", "and", "for", "with", "news", "today", "latest", "about", "from", "what", "this", "that"]);

// Every recent headline from all feeds, newest first, without duplicates.
async function allFeedItems(maxAgeHours = 72) {
  const lists = await Promise.all(Object.entries(FEEDS).flatMap(([source, urls]) =>
    urls.map(u => rssItems(u, {}, 60).then(items => items.map(i => ({ ...i, source }))).catch(() => []))));
  const cutoff = Date.now() - maxAgeHours * 3600e3, seen = new Set(), out = [];
  for (const it of lists.flat()) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 70);
    if (!it.title || !it.link || seen.has(key)) continue;
    const time = Date.parse(it.pubDate) || 0;
    if (time && time < cutoff) continue;
    seen.add(key);
    out.push({ ...it, time });
  }
  return out.sort((a, b) => b.time - a.time);
}

const publicItem = ({ link, title, source, image, description, time }) => ({ link, title, source, image, description: (description || "").slice(0, 300), time });

// Two headlines about the same event share most of their meaningful words.
const SMALL = new Set([...STOP, "says", "said", "will", "may", "over", "after", "into", "its", "their", "has", "have", "are", "was", "how", "why", "who", "here", "check", "amid"]);
const sigWords = t => new Set(((t || "").toLowerCase().match(/[a-z0-9₹$%.]+/g) || []).filter(w => w.length > 2 && !SMALL.has(w)));
function sameEvent(a, b) {
  const A = sigWords(a), B = sigWords(b);
  if (!A.size || !B.size) return false;
  let common = 0; for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size) >= 0.5;
}
function dropRepeats(items) {
  const kept = [];
  for (const it of items) if (!kept.some(k => sameEvent(k.title, it.title))) kept.push(it);
  return kept;
}

async function feedSearch(query, limit = 5) {
  const terms = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1 && !STOP.has(t));
  if (!terms.length) return [];
  const scored = [];
  for (const it of await allFeedItems()) {
    const title = it.title.toLowerCase(), all = (it.title + " " + (it.description || "")).toLowerCase();
    let score = 0;
    for (const t of terms) { const re = new RegExp(`\\b${t}`); if (re.test(title)) score += 2; else if (re.test(all)) score += 1; }
    const needed = terms.length === 1 ? 2 : terms.length; // one word: must be in the headline; more: roughly every word somewhere
    if (score >= needed) scored.push({ ...it, score });
  }
  scored.sort((a, b) => b.score - a.score || b.time - a.time);
  return dropRepeats(scored).slice(0, limit).map(publicItem);
}

// ---------------------------------------------------------------- today's picks
const PICKS_TTL_MS = 3 * 3600e3;  // refresh at most every 3 hours (keeps well inside the free AI allowance)
const PICKS_PROMPT = `You choose news for "Fyntrest Bytes", Instagram stories by Fyntrest, a financial literacy brand for Indian students and young earners (age 16-28).
From the numbered headlines below, choose the 6 that are most worth a story today. Prefer news that:
- touches their own money: loans and EMIs, taxes, jobs and salaries, savings, prices, UPI and banking, investing basics
- is a big market or economy move, or an RBI / SEBI / government decision
- involves companies or people they know and talk about
Avoid: stock tips and target prices, routine quarterly results of small companies, very regional news, and more than one headline about the same event.
For "why", say what it means for the reader, not what happened. Good: "Lose your job? You can now withdraw your PF much faster." Bad: "EPFO approves PF changes."
Reply with only JSON, copying each chosen headline exactly:
{"picks":[{"n":<headline number>,"title":"<the headline, copied exactly>","tag":"<one word: India, Markets, Banking, Tax, Jobs, Tech, Global...>","why":"<one short sentence, at most 14 words, speaking to the reader as you>"}]}`;

async function getPicks(env, force = false) {
  if (env.PICKS) {
    const saved = await env.PICKS.get("picks", "json").catch(() => null);
    // "force" (a Refresh tap) still reuses picks made in the last 10 minutes, so it can't burn the free AI allowance.
    const maxAge = force ? 10 * 60e3 : PICKS_TTL_MS;
    if (saved && Date.now() - saved.generatedAt < maxAge) return saved;
  }
  const items = dropRepeats(await allFeedItems(36)).slice(0, 150);
  if (!items.length) throw new UserError("Couldn't load today's news right now. Try again in a minute.", 503);
  const list = items.map((it, i) => `[${i + 1}] ${it.title} (${it.source})`).join("\n");
  let picks = [];
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [{ role: "system", content: PICKS_PROMPT }, { role: "user", content: list }],
      max_tokens: 500, temperature: 0.3,
    });
    const out = parseJson(res?.response);
    const used = new Set();
    for (const p of out?.picks || []) {
      // Match by the copied headline (models sometimes mix up numbers); the number is only a fallback.
      let it = items[Number(p.n) - 1];
      if (p.title && (!it || !sameEvent(it.title, p.title))) it = items.find(x => sameEvent(x.title, p.title));
      if (!it || used.has(it.link) || picks.some(p2 => sameEvent(p2.title, it.title))) continue;
      used.add(it.link);
      picks.push({ ...publicItem(it), tag: String(p.tag || "").trim().slice(0, 14), why: String(p.why || "").trim().replace(/\s*—\s*/g, ", ").slice(0, 120) });
    }
  } catch (e) { console.log("picks AI failed", String(e)); }
  if (!picks.length) picks = items.slice(0, 6).map(it => ({ ...publicItem(it), tag: "", why: "" }));  // newest headlines as a fallback
  const result = { generatedAt: Date.now(), picks };
  if (env.PICKS) await env.PICKS.put("picks", JSON.stringify(result)).catch(e => console.log("KV put failed", String(e)));
  return result;
}

async function rssItems(url, extraHeaders = {}, max = 5) {
  let xml = "";
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "en-IN,en;q=0.9", ...extraHeaders } });
    if (!r.ok) { console.log("RSS", url.slice(0, 40), r.status); return []; }
    xml = await r.text();
  } catch (e) { console.log("RSS failed", String(e)); return []; }
  const hits = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = t => decode((m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "");
    let title = tag("title"), source = tag("source") || tag("News:Source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const link = tag("link");
    const img = (m[1].match(/<(?:media:content|media:thumbnail|enclosure)[^>]+url=["']([^"']+)["']/i) || [])[1] || "";
    if (link) hits.push({ link, title, source, description: decode(tag("description").replace(/<[^>]+>/g, " ")).trim(), pubDate: tag("pubDate"), image: decode(img) });
    if (hits.length >= max) break;
  }
  return hits;
}

// ---------------------------------------------------------------- writing (Gemini)
const PROMPT = `You write Instagram story copy for "Fyntrest Bytes", a finance-news story series by Fyntrest, a financial literacy brand for Indian students and young earners.
Use ONLY facts from the article below. Never invent numbers, names or quotes.

Return JSON with:
- tag: one word, e.g. India, Global, Markets, Tax, Jobs, Banking, Tech
- source: the publication's name as people know it (e.g. Mint, BBC News, CNBC, Economic Times)
- hook: one complete, natural sentence of 7 to 12 words that carries the most surprising fact or number in the story. Wrap the key 1-3 words in *asterisks*.
- body: exactly 2 complete sentences, 20 to 35 words in total. Facts only.
- take: exactly 2 complete sentences, 18 to 30 words in total, speaking to the reader as "you": what this means for a student or young earner in India. Practical, not preachy.
Rules: write like a friendly explainer in natural full sentences, never telegraphic notes. Simple English, no em dashes, no hashtags, no emoji.

Example of the style (different article):
{"tag":"Markets","source":"CNBC","hook":"Nvidia's CEO *resigned*. Now investors are nervous.","body":"Jensen Huang co-founded the AI chip giant. With him gone, the shares are falling right before its earnings report.","take":"When one person is the face of a company, their exit can move the stock overnight. That's why you spread your money out."}`;

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function cleanCopy(out, fallback) {
  const copy = {};
  for (const k of ["tag", "source", "hook", "body", "take"]) copy[k] = String(out?.[k] ?? "").trim().replace(/\s*—\s*/g, ", ");
  copy.source = copy.source || fallback.source;
  copy.hook = copy.hook || fallback.hook;
  copy.tag = copy.tag || "News";
  return copy;
}

function parseJson(x) {
  if (x && typeof x === "object") return x;
  const t = String(x || "");
  const m = t.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : t);
}

async function writeCopy(info, env) {
  const fallback = { tag: "News", source: info.site_name || info.source_hint || "", hook: info.title, body: sentences(info.description, 220), take: "" };
  const article = `Article URL: ${info.url}\nSite: ${info.site_name || info.source_hint || ""}\nHeadline: ${info.title}\nSummary: ${info.description || ""}\nText:\n${(info.text || "").slice(0, 5000)}`;
  // Cloudflare Workers AI: included in the free plan, no key needed.
  if (env.AI) {
    try {
      const res = await env.AI.run(AI_MODEL, {
        messages: [
          { role: "system", content: PROMPT + '\nReply with only one JSON object: {"tag":"","source":"","hook":"","body":"","take":""}' },
          { role: "user", content: article },
        ],
        max_tokens: 400, temperature: 0.5,
      });
      return { copy: cleanCopy(parseJson(res?.response), fallback), note: "" };
    } catch (e) {
      console.log("Workers AI failed", String(e));
      if (!env.GEMINI_API_KEY) {
        const why = /limit|quota|429|neuron/i.test(String(e)) ? "Today's free AI writing is used up." : "The AI writer didn't answer.";
        return { copy: fallback, note: why + " The headline is used as-is; edit the words below." };
      }
    }
  }
  if (!env.GEMINI_API_KEY) return { copy: fallback, note: "AI text is off, so the headline is used as-is. Edit the words below." };
  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT + "\n\n" + article }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.6 } }),
    });
    if (!r.ok) {
      console.log("Gemini", r.status, (await r.text()).slice(0, 300));
      const why = r.status === 429 ? "Gemini's free limit is used up for now." : `Gemini error ${r.status}.`;
      return { copy: fallback, note: why + " The headline is used as-is; edit the words below." };
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    return { copy: cleanCopy(parseJson(text), fallback), note: "" };
  } catch (e) {
    console.log("Gemini failed", String(e));
    return { copy: fallback, note: "Gemini didn't answer. The headline is used as-is; edit the words below." };
  }
}

// ---------------------------------------------------------------- helpers
const sleep = ms => new Promise(r => setTimeout(r, ms));
const words = t => new Set(((t || "").toLowerCase().match(/[a-z0-9]{3,}/g)) || []);
const overlap = (a, b) => { const B = words(b); let n = 0; for (const w of words(a)) if (B.has(w)) n++; return n; };
const hostname = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const istDate = () => new Date(Date.now() + 5.5 * 3600e3).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function sentences(text, limit) {
  let out = "";
  for (const s of (text || "").trim().split(/(?<=[.!?])\s+/)) { if (out.length + s.length + 1 > limit) break; out = (out + " " + s).trim(); }
  return out;
}
function decode(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").trim();
}
