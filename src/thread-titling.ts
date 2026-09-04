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
  return stripped.length > MAX_TITLE_LENGTH ? `${stripped.slice(0, MAX_TITLE_LENGTH - 1)}…` : stripped;
}

registerSessionCreatedHook(async (event) => {
  if (!event.threadId) return;
  const title = extractTitle(event.message.content);
  if (!title) return;
  try {
    await setThreadTitle(event.mg.instance ?? event.mg.channel_type, event.platformId, event.threadId, title);
  } catch (err) {
    log.warn('Thread auto-titling failed', { sessionId: event.session.id, err });
  }
});
