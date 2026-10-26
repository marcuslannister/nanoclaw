import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn().mockResolvedValue(undefined);
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));
vi.mock('./modules/approvals/primitive.js', () => ({
  pickApprover: async () => ['discord:owner'],
  pickApprovalDelivery: async () => ({
    userId: 'discord:owner',
    messagingGroup: { channel_type: 'discord', platform_id: 'discord:@me:1', instance: 'discord' },
  }),
}));

const { ALERT_AFTER_MS, noteWakeFailure, noteWakeSuccess, resetWakeFailureAlertForTesting } =
  await import('./wake-failure-alert.js');

const texts = () => deliver.mock.calls.map((c) => JSON.parse(c[4]).text as string);

describe('wake-failure alert', () => {
  beforeEach(() => {
    deliver.mockClear();
    resetWakeFailureAlertForTesting();
  });

  it('alerts once after failures persist, then reports recovery', async () => {
    noteWakeFailure(new Error('fetch failed'), 0);
    noteWakeFailure(new Error('fetch failed'), ALERT_AFTER_MS - 1);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(0));

    noteWakeFailure(new Error('fetch failed'), ALERT_AFTER_MS);
    noteWakeFailure(new Error('fetch failed'), ALERT_AFTER_MS * 2);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(texts()[0]).toContain('fetch failed');

    noteWakeSuccess();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(texts()[1]).toContain('start again');
  });

  it('stays silent when a success interrupts the failures', async () => {
    noteWakeFailure(new Error('x'), 0);
    noteWakeSuccess();
    noteWakeFailure(new Error('x'), ALERT_AFTER_MS);
    await new Promise((r) => setTimeout(r, 10));
    expect(deliver).not.toHaveBeenCalled();
  });
});
