/**
 * Delivery attempt rows: recorded with the failure, cleared on success or
 * permanent give-up. (Originally written for the shadow phase; the rows are
 * now the authority for retry counts and every assertion carried unchanged.)
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-delivery-shadow',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-shadow/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-shadow';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveryAttempt } from './db/coordination.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

async function seedAgentAndChannel(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('delivery attempt shadow rows', () => {
  it('records attempts with the error, and clears on eventual success', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    let failuresLeft = 1;
    setDeliveryAdapter({
      async deliver() {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error('channel offline');
        }
        return 'plat-msg-1';
      },
    });

    await deliverSessionMessages(session);
    const afterFailure = await getDeliveryAttempt('out-1');
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.session_id).toBe(session.id);
    expect(afterFailure?.last_error).toContain('channel offline');
    expect(afterFailure?.next_attempt_at).not.toBeNull();

    // The retry waits out the first backoff (5s).
    vi.useFakeTimers({ now: Date.now() + 5_000 });
    try {
      await deliverSessionMessages(session);
    } finally {
      vi.useRealTimers();
    }
    expect(await getDeliveryAttempt('out-1')).toBeUndefined();
  });

  it('clears the row when delivery gives up permanently', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-poison');

    setDeliveryAdapter({
      async deliver() {
        throw new Error('always fails');
      },
    });

    // MAX_DELIVERY_ATTEMPTS is 7: six failures (each waiting out its backoff)
    // leave the row counting…
    vi.useFakeTimers();
    try {
      await deliverSessionMessages(session);
      for (const waitMs of [5_000, 10_000, 20_000, 40_000, 80_000]) {
        vi.advanceTimersByTime(waitMs);
        await deliverSessionMessages(session);
      }
      expect((await getDeliveryAttempt('out-poison'))?.attempts).toBe(6);

      // …the seventh marks the message failed mailbox-side and clears the row —
      // the attempt bookkeeping's job is done.
      vi.advanceTimersByTime(160_000);
      await deliverSessionMessages(session);
      expect(await getDeliveryAttempt('out-poison')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never writes a row for a first-time success', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-clean');

    setDeliveryAdapter({
      async deliver() {
        return 'plat-msg-2';
      },
    });

    await deliverSessionMessages(session);
    expect(await getDeliveryAttempt('out-clean')).toBeUndefined();
  });
});
