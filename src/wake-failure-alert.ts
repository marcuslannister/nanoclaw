/**
 * DMs the owner when container wakes keep failing (e.g. Docker or the
 * credential gateway is down), and again when a wake succeeds. Delivery goes
 * straight through the host's channel adapter, so it works with no container.
 */
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { pickApprovalDelivery, pickApprover } from './modules/approvals/primitive.js';

export const ALERT_AFTER_MS = 5 * 60_000;

let firstFailureAt: number | null = null;
let alerted = false;

export function noteWakeFailure(err: unknown, now = Date.now()): void {
  firstFailureAt ??= now;
  if (alerted || now - firstFailureAt < ALERT_AFTER_MS) return;
  alerted = true;
  const reason = err instanceof Error ? err.message : String(err);
  void notifyOwner(
    `⚠️ Agents cannot start for ${Math.round((now - firstFailureAt) / 60_000)} min: ${reason}. Check Docker and the gateway.`,
  );
}

export function noteWakeSuccess(): void {
  if (alerted) void notifyOwner('✅ Agents start again.');
  firstFailureAt = null;
  alerted = false;
}

async function notifyOwner(text: string): Promise<void> {
  try {
    const adapter = getDeliveryAdapter();
    const target = await pickApprovalDelivery(await pickApprover(null), '');
    if (!adapter || !target) {
      log.warn('Wake-failure alert has no delivery target', { text });
      return;
    }
    const mg = target.messagingGroup;
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      mg.instance,
    );
  } catch (err) {
    log.error('Failed to deliver wake-failure alert', { text, err });
  }
}

export function resetWakeFailureAlertForTesting(): void {
  firstFailureAt = null;
  alerted = false;
}
