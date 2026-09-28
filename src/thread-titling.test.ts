/**
 * Auto-titling a brand-new platform thread from the triggering message.
 * Exercised through the REAL routeInbound path so the session-created hook
 * wiring (src/thread-titling.ts, self-registered via src/index.ts) is
 * covered end to end, not just the extraction helper in isolation.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
// Import for its side effect: registers the session-created hook under test.
import './thread-titling.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-titling' };
});

const TEST_DIR = '/tmp/nanoclaw-test-thread-titling';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const setThreadTitle = vi.fn().mockResolvedValue(undefined);

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
    setThreadTitle,
  };
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedWiring(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(id: string, threadId: string | null, text: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'U1', text }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  setThreadTitle.mockClear();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('thread auto-titling', () => {
  it('titles a brand-new thread from the triggering message, stripped of mention markup', async () => {
    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', '<@123> research what is skill in claude code');

    expect(setThreadTitle).toHaveBeenCalledTimes(1);
    expect(setThreadTitle).toHaveBeenCalledWith(
      'testchat:C1',
      'testchat:C1:171',
      'research what is skill in claude code',
    );
  });

  it('truncates long titles to 80 chars with an ellipsis', async () => {
    await activate();
    await seedWiring();

    const long = 'a'.repeat(120);
    await inbound('m1', 'testchat:C1:171', long);

    const title = setThreadTitle.mock.calls[0][2];
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('does not fire again when the thread session already exists', async () => {
    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'first message');
    await inbound('m2', 'testchat:C1:171', 'follow-up');

    expect(setThreadTitle).toHaveBeenCalledTimes(1);
  });

  it('titles a link-only message from the page <title> instead of the raw URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html><head><title>Example Domain</title></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'https://example.com/some-article');

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/some-article', expect.any(Object));
    expect(setThreadTitle).toHaveBeenCalledWith('testchat:C1', 'testchat:C1:171', 'Example Domain');

    vi.unstubAllGlobals();
  });

  it('strips a trailing " — Show — Site" suffix and decodes named entities', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<html><head><title>105 她在危地马拉🇬🇹、厄瓜多尔🇪🇨、尼加拉瓜🇳🇮的158天 &mdash; Coffeeplus播客 &mdash; Overcast</title></head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'https://overcast.fm/+abc123');

    expect(setThreadTitle).toHaveBeenCalledWith(
      'testchat:C1',
      'testchat:C1:171',
      '105 她在危地马拉🇬🇹、厄瓜多尔🇪🇨、尼加拉瓜🇳🇮的158天',
    );

    vi.unstubAllGlobals();
  });

  it('titles a YouTube link from oEmbed instead of scraping the page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ title: 'Deep-Dive with Prot: Emacs, Philosophy, Debian, Life & Open-Source Ethics' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'https://www.youtube.com/watch?v=b4nV0jCHwGQ');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://www.youtube.com/oembed?url='),
      expect.any(Object),
    );
    expect(setThreadTitle).toHaveBeenCalledWith(
      'testchat:C1',
      'testchat:C1:171',
      'Deep-Dive with Prot: Emacs, Philosophy, Debian, Life & Open-Source Ethics',
    );

    vi.unstubAllGlobals();
  });

  it('titles an accidental double-paste of the same URL from the page, not the raw duplicated text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<html><head><title>collie</title></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'https://github.com/AltanS/collie https://github.com/AltanS/collie');

    expect(fetchMock).toHaveBeenCalledWith('https://github.com/AltanS/collie', expect.any(Object));
    expect(setThreadTitle).toHaveBeenCalledWith('testchat:C1', 'testchat:C1:171', 'collie');

    vi.unstubAllGlobals();
  });

  it('falls back to og:title when <title> is empty (JS-rendered SPA pages)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<html><head><title></title><meta property="og:title" content="Matt Pocock 的 AI 工程工作流"></head></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'https://mp.weixin.qq.com/s/abc123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mp.weixin.qq.com/s/abc123',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
    expect(setThreadTitle).toHaveBeenCalledWith('testchat:C1', 'testchat:C1:171', 'Matt Pocock 的 AI 工程工作流');

    vi.unstubAllGlobals();
  });

  it('leaves genuinely different multi-link messages to the raw-text fallback', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'https://example.com/a https://example.com/b');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(setThreadTitle).toHaveBeenCalledWith(
      'testchat:C1',
      'testchat:C1:171',
      'https://example.com/a https://example.com/b',
    );

    vi.unstubAllGlobals();
  });

  it('falls back to the raw URL as the title when the page fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await activate();
    await seedWiring();

    await inbound('m1', 'testchat:C1:171', 'https://example.com/some-article');

    expect(setThreadTitle).toHaveBeenCalledWith('testchat:C1', 'testchat:C1:171', 'https://example.com/some-article');

    vi.unstubAllGlobals();
  });

  it('is a no-op when the adapter has no setThreadTitle capability', async () => {
    registerChannelAdapter('testchat', {
      factory: () => {
        const { setThreadTitle: _omit, ...rest } = makeAdapter();
        return rest;
      },
      defaults: channelDefaults,
    });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
    await seedWiring();

    await expect(inbound('m1', 'testchat:C1:171', 'hello')).resolves.toBeUndefined();
    expect(setThreadTitle).not.toHaveBeenCalled();
  });
});
