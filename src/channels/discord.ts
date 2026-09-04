/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). The adapter only reads `content`/`attachments`, so without this the
 * agent sees an empty message. Unwrap the snapshot back into the payload so
 * text, attachment download, and formatting all ride the existing path.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
}

/**
 * `threadId` is the Chat SDK's compound form (`discord:{guild}:{channel}:{thread}`
 * — see `channelIdFromThreadId` in `@chat-adapter/discord`); Discord's REST API
 * wants only the trailing snowflake. Threads are channels for rename purposes:
 * `PATCH /channels/{id}` with `{ name }`. Discord caps thread names at 100 chars;
 * the caller already truncates well under that, so no further clamping here.
 *
 * A 3-part id (`discord:{guild}:{channel}`, no thread segment) means no
 * thread actually exists for this message — e.g. thread creation failed or
 * the bot lacks permission. Renaming would hit the parent text channel
 * instead, so skip silently rather than mistitle it.
 */
export async function renameDiscordThread(botToken: string, threadId: string, title: string): Promise<void> {
  const parts = threadId.split(':');
  if (parts.length < 4) return;
  const id = parts[parts.length - 1];
  const res = await fetch(`https://discord.com/api/v10/channels/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: title }),
  });
  if (!res.ok) {
    throw new Error(`Discord thread rename failed: ${res.status} ${await res.text()}`);
  }
}

function unwrapForwards(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return orig(data, options);
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    unwrapForwards(discordAdapter);
    const bridge = createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken: env.DISCORD_BOT_TOKEN,
      extractReplyContext,
      supportsThreads: true,
      defaults: DISCORD_DEFAULTS,
      // Discord rejects messages over 2000 chars; without this the bridge
      // would let long agent replies fail instead of splitting them.
      maxTextLength: 2000,
    });
    bridge.setThreadTitle = (_platformId, threadId, title) =>
      renameDiscordThread(env.DISCORD_BOT_TOKEN!, threadId, title);
    return bridge;
  },
  defaults: DISCORD_DEFAULTS,
});
