/**
 * Auto-titles a brand-new platform thread from the message that created it.
 * Adapters without a thread-title concept (setThreadTitle unimplemented) are
 * a silent no-op via channel-registry's passthrough — titling is decoration,
 * never worth a delivery failure.
 */
import { setThreadTitle } from './channels/channel-registry.js';
import { log } from './log.js';
import { registerSessionCreatedHook } from './router.js';

const MAX_TITLE_LENGTH = 80;
const LINK_FETCH_TIMEOUT_MS = 5000;
const LINK_FETCH_MAX_BYTES = 100_000; // enough to reach <title> on virtually any page

function truncate(text: string): string {
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}

function extractTitle(rawContent: string): string | null {
  let text: unknown;
  try {
    text = JSON.parse(rawContent)?.text;
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const stripped = text
    .replace(/<@!?\d+>/g, '') // platform mention markup (e.g. Discord)
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return truncate(stripped);
}

/**
 * True when the message is nothing but a URL — the link-paste-to-summarize
 * pattern. Tolerates an accidental double-paste of the same URL (two
 * whitespace-separated tokens, both identical); genuinely different URLs in
 * one message are ambiguous, so those fall through to the raw-text title.
 */
function soleUrl(rawContent: string): string | null {
  let text: unknown;
  try {
    text = JSON.parse(rawContent)?.text;
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const tokens = text
    .replace(/<@!?\d+>/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || !tokens.every((t) => /^https?:\/\/\S+$/.test(t))) return null;
  return new Set(tokens).size === 1 ? tokens[0] : null;
}

/** youtube.com/youtu.be watch and short links — null for anything else. */
function youtubeOembedUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (host !== 'youtube.com' && host !== 'youtu.be' && host !== 'm.youtube.com') return null;
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
}

/**
 * YouTube's own <title> sits ~700KB into the page (heavy inline scripts
 * before <head>'s metadata), past any byte cap worth paying for on every
 * link. oEmbed is the platform's own lightweight metadata endpoint — a few
 * hundred bytes, entities already decoded.
 */
async function fetchYoutubeTitle(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { title?: unknown };
    return typeof data.title === 'string' ? data.title.trim() || null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cleanTitle(raw: string): string | null {
  const decoded = raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    // Many sites append " — Site Name" (and podcast pages often add a show
    // name too, e.g. "Episode — Show — Overcast") — keep just the episode.
    .split(' — ')[0]
    .replace(/\s+/g, ' ')
    .trim();
  return decoded || null;
}

/** og:title meta tag's content= value, tolerating either attribute order. */
function extractOgTitle(html: string): string | null {
  const tag =
    html.match(/<meta\b[^>]*\bproperty=["']og:title["'][^>]*>/i) ??
    html.match(/<meta\b[^>]*\bcontent=["'][^"']*["'][^>]*\bproperty=["']og:title["'][^>]*>/i);
  const content = tag?.[0].match(/content=["']([^"']*)["']/i);
  return content ? content[1] : null;
}

async function fetchPageTitle(url: string): Promise<string | null> {
  const oembedUrl = youtubeOembedUrl(url);
  if (oembedUrl) {
    const title = await fetchYoutubeTitle(oembedUrl);
    if (title) return title;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      // Some sites (e.g. WeChat's mp.weixin.qq.com) serve an anti-bot decoy
      // page — no title, no og:title — to requests that don't look like a
      // browser.
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
    });
    if (!res.ok || !res.body) return null;
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null;

    let html = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      html += Buffer.from(chunk).toString('utf8');
      // A non-empty <title> or an og:title meta tag are both worth stopping
      // for; an *empty* <title> (some SPAs set it via JS at runtime, leaving
      // the static HTML's tag blank) is not — keep reading for og:title.
      if (
        html.length >= LINK_FETCH_MAX_BYTES ||
        /<title[^>]*>[^<]+<\/title>/i.test(html) ||
        /<meta\b[^>]*property=["']og:title["']/i.test(html)
      ) {
        break;
      }
    }
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return cleanTitle(titleMatch?.[1] ?? extractOgTitle(html) ?? '');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

registerSessionCreatedHook(async (event) => {
  if (!event.threadId) return;

  const url = soleUrl(event.message.content);
  const linkTitle = url ? await fetchPageTitle(url) : null;
  const title = linkTitle ? truncate(linkTitle) : extractTitle(event.message.content);
  if (!title) return;

  try {
    await setThreadTitle(event.mg.instance ?? event.mg.channel_type, event.platformId, event.threadId, title);
  } catch (err) {
    log.warn('Thread auto-titling failed', { sessionId: event.session.id, err });
  }
});
