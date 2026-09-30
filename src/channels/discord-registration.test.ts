/**
 * Integration test for the discord channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs discord.ts's
 * top-level `registerChannelAdapter('discord', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './discord.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and discord.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. It does require the adapter package (`@chat-adapter/discord`) to be installed,
 * which holds in a composed install: the skill's `pnpm install` step runs before this
 * test — so this test also implicitly guards that dependency (an unmocked import throws
 * if the package is missing).
 *
 * discord is a Chat SDK channel: discord.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js. That core-consumption is a
 * typed call, so the build/typecheck leg (`pnpm run build`) guards it against upstream
 * drift, not this test. Every Chat SDK channel follows this same shape.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import { renameDiscordThread } from './discord.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('discord channel registration', () => {
  it('registers discord via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('discord');
  });
});

describe('renameDiscordThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips a 3-part id (no thread segment) rather than renaming the parent channel', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await renameDiscordThread('tok', 'discord:guild1:channel1', 'title');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renames the trailing thread segment of a 4-part id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await renameDiscordThread('tok', 'discord:guild1:channel1:thread1', 'title');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/thread1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
