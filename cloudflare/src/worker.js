// Fyntrest Bytes on Cloudflare Workers (free plan).
// POST /api/story {query} -> headline screenshot (base64 PNG) + story text. The phone draws the story image.
//
// Text is written by Cloudflare Workers AI (free plan, no key). Optional secrets
// (set with `npx wrangler secret put NAME`):
//   TEAM_PASSWORD   when set, the page asks for it
//   GEMINI_API_KEY  only used if Workers AI fails (Gemini's free tier must be available to your Google project)
// Variable (wrangler.jsonc "vars"): GEMINI_MODEL, default gemini-2.5-flash
//
// Free-plan budget: 10 browser-minutes a day (resets 00:00 UTC = 5:30 am IST), 1 new browser every 20 s.
// So the browser is closed the moment the screenshot is taken; nothing else runs while it is open.
import puppeteer from "@cloudflare/puppeteer";
import { CLEAN_JS, NO_IMAGES_JS, FIND_JS, RECT_JS } from "./page-scripts.js";

const DAILY_SECONDS = 600;      // free plan: 10 browser-minutes a day
const SECONDS_PER_STORY = 15;   // rough cost of one story, for the "stories left" estimate
const DAILY_LIMIT_MSG = "Today's free screenshot time is used up. It resets at 5:30 am IST. Try again then.";
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";

const ARTICLE_JS = `(() => {
  const meta = s => document.querySelector(s)?.content?.trim() || '';
  const h1 = document.querySelector('[data-story-headline]') ||
    [...document.querySelectorAll('h1')].find(h => h.innerText.trim().length > 15);
  const paras = [...document.querySelectorAll('article p, main p, p')]
    .map(p => p.innerText.trim()).filter(t => t.length > 80).slice(0, 12);
  return {
    title: (h1?.innerText || meta('meta[property="og:title"]') || document.title || '').trim(),
    description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
    site_name: meta('meta[property="og:site_name"]'),
    text: paras.join('\\n\\n').slice(0, 7000),
    url: location.href,
  };
})()`;

const OG_TITLE_JS = `(document.querySelector('meta[property="og:title"]')?.content || document.querySelector('meta[name="twitter:title"]')?.content || '').trim()`;

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
      if (url.pathname === "/api/config") {
        const lim = await puppeteer.limits(env.MYBROWSER).catch(() => null);
        const left = lim && typeof lim.usedBrowserTimeSeconds === "number" ? Math.max(0, DAILY_SECONDS - lim.usedBrowserTimeSeconds) : null;
        return json({ password: !!env.TEAM_PASSWORD, ai: !!(env.AI || env.GEMINI_API_KEY), storiesLeft: left === null ? null : Math.floor(left / SECONDS_PER_STORY) });
      }
      if (url.pathname === "/api/status") {
        // For checking the free browser allowance: open sessions and recent browser use (no secrets).
        const [limits, sessions, history] = await Promise.all([
          puppeteer.limits(env.MYBROWSER).catch(e => ({ error: String(e) })),
          puppeteer.sessions(env.MYBROWSER).catch(e => ({ error: String(e) })),
          puppeteer.history(env.MYBROWSER).catch(e => ({ error: String(e) })),
        ]);
        const recent = Array.isArray(history) ? history.slice(0, 30) : history;
        return json({ limits, sessions, recent });
      }
      if (url.pathname === "/api/story" && request.method === "POST") {
        if (env.TEAM_PASSWORD && request.headers.get("x-team-password") !== env.TEAM_PASSWORD) throw new UserError("Wrong team password.", 401);
        const { query = "" } = await request.json().catch(() => ({}));
        if (query.trim().length < 3) throw new UserError("Paste a news link or type a topic.");
        return json(await makeStory(query.trim(), env));
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status);
      const msg = String(e?.message || e);
      console.log("ERROR", msg);
      if (/time limit exceeded|exceeded for today|daily/i.test(msg)) return json({ error: DAILY_LIMIT_MSG }, 429);
      if (/429|rate limit|too many/i.test(msg)) return json({ error: "Someone else is making a story right now. Try again in 20 seconds." }, 503);
      return json({ error: "Something went wrong making that story. Try again, or try another link." }, 500);
    }
  },
};

// ---------------------------------------------------------------- browser
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

async function capture(page, link, expectedTitle = "") {
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (page.url().includes("news.google.com")) {
    // Google News links forward to the publisher through a script.
    await page.waitForFunction(() => !location.hostname.includes("news.google.com"), { timeout: 15_000 }).catch(() => {});
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
  }
  await sleep(2500);
  // Cloudflare's browsers often run in Europe, where sites show cookie walls first: accept them.
  if (await acceptConsent(page)) await sleep(2000);
  if (!expectedTitle) expectedTitle = await page.evaluate(OG_TITLE_JS).catch(() => "");
  for (let i = 0; i < 2; i++) { await page.evaluate(`(${CLEAN_JS})()`).catch(() => {}); await sleep(600); }
  await page.evaluate(`(${NO_IMAGES_JS})()`).catch(() => {});
  const found = await page.evaluate(`(${FIND_JS})()`).catch(() => null);
  let headline = null;
  if (found) {
    await sleep(500);
    const clip = (await page.evaluate(`(${RECT_JS})()`).catch(() => null)) || found.head;
    if (clip && clip.width > 20 && clip.height > 10) {
      headline = await page.screenshot({ clip, encoding: "base64" }).catch(() => null);
    }
  }
  const info = await page.evaluate(ARTICLE_JS).catch(() => ({ title: "", description: "", site_name: "", text: "", url: page.url() }));
  // A screenshot of the wrong heading (site name, section title) does not count.
  if (expectedTitle && overlap(info.title, expectedTitle) < 2) { info.title = expectedTitle; headline = null; }
  info.headline = headline;
  return info;
}

async function makeStory(query, env) {
  const isLink = /^https?:\/\//i.test(query);
  const hits = isLink ? [{ link: query, title: "", source: "" }] : await googleNews(query);
  if (!hits.length) throw new UserError("No recent news found for that. Try different words or paste a link.", 404);

  const browser = await getBrowser(env);
  let info = null;
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true });
    for (const hit of hits.slice(0, isLink ? 1 : 2)) {  // first result whose headline screenshots cleanly
      let got;
      try { got = await capture(page, hit.link, hit.title); } catch (e) { if (/limit|exceeded/i.test(String(e))) throw e; continue; }
      got.source_hint = hit.source;
      if (!got.title) got.title = hit.title;
      if (got.headline) { info = got; break; }
      info = info || got;
    }
  } finally {
    await browser.close().catch(() => {});  // stop the browser clock right away
  }
  if (!info) info = { ...hits[0], url: hits[0].link, description: "", site_name: hits[0].source, text: "", source_hint: hits[0].source, headline: null };
  if (!info.title) throw new UserError("Couldn't read that article. Try another link.", 422);

  const { copy, note } = await writeCopy(info, env);
  const notes = [note, info.headline ? "" : "This site blocked the screenshot, so the headline is shown as a plain card."].filter(Boolean);
  return {
    headline: info.headline ? "data:image/png;base64," + info.headline : null,
    title: info.title,
    site: hostname(info.url),
    fields: { ...copy, date: istDate() },
    note: notes.join(" "),
  };
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
  "BBC News": ["https://feeds.bbci.co.uk/news/business/rss.xml"],
  "CNBC": ["https://www.cnbc.com/id/10000664/device/rss/rss.html", "https://www.cnbc.com/id/100727362/device/rss/rss.html"],
};
const STOP = new Set(["the", "and", "for", "with", "news", "today", "latest", "about", "from", "what", "this", "that"]);

async function feedSearch(query) {
  const terms = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1 && !STOP.has(t));
  if (!terms.length) return [];
  const lists = await Promise.all(Object.entries(FEEDS).flatMap(([source, urls]) =>
    urls.map(u => rssItems(u, {}, 60).then(items => items.map(i => ({ ...i, source }))).catch(() => []))));
  const seen = new Set(), scored = [];
  for (const it of lists.flat()) {
    const key = it.title.toLowerCase().slice(0, 80);
    if (!it.title || seen.has(key)) continue;
    seen.add(key);
    const title = it.title.toLowerCase(), all = (it.title + " " + (it.description || "")).toLowerCase();
    let score = 0;
    for (const t of terms) { const re = new RegExp(`\\b${t}`); if (re.test(title)) score += 2; else if (re.test(all)) score += 1; }
    const needed = terms.length === 1 ? 2 : terms.length; // one word: must be in the headline; more: roughly every word somewhere
    if (score >= needed) scored.push({ ...it, score, time: Date.parse(it.pubDate) || 0 });
  }
  scored.sort((a, b) => b.score - a.score || b.time - a.time);
  return scored.slice(0, 5).map(({ link, title, source }) => ({ link, title, source }));
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
    if (link) hits.push({ link, title, source, description: tag("description").replace(/<[^>]+>/g, " "), pubDate: tag("pubDate") });
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
