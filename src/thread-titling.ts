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

/** True when the message is nothing but a single URL (link-paste-to-summarize pattern). */
function soleUrl(rawContent: string): string | null {
  let text: unknown;
  try {
    text = JSON.parse(rawContent)?.text;
  } catch {
    return null;
  }
  if (typeof text !== 'string') return null;
  const stripped = text.replace(/<@!?\d+>/g, '').trim();
  return /^https?:\/\/\S+$/.test(stripped) ? stripped : null;
}

async function fetchPageTitle(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) return null;
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null;

    let html = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      html += Buffer.from(chunk).toString('utf8');
      if (html.length >= LINK_FETCH_MAX_BYTES || /<title[^>]*>[^<]*<\/title>/i.test(html)) break;
    }
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (!match) return null;
    const decoded = match[1]
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
