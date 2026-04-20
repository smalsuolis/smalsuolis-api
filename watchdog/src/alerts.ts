import { Telegraf } from 'telegraf';
import { allSubscribers, getAlertLastSent, markAlertSent, clearAlert } from './db';
import { config } from './config';
import { log } from './logger';

/**
 * Returns true if the message was delivered to at least one subscriber.
 * Callers should gate dedup/alert-state persistence on this — otherwise an
 * alert fired before anyone subscribed would lock out future alerts for the
 * same key even though nothing was ever received.
 */
export async function broadcast(bot: Telegraf, message: string): Promise<boolean> {
  const subs = allSubscribers();
  if (subs.length === 0) {
    log.warn('[watchdog] no subscribers, skipping broadcast:', message);
    return false;
  }
  await Promise.all(
    subs.map((s) =>
      bot.telegram.sendMessage(s.chatId, message, { parse_mode: 'Markdown' }).catch((err) => {
        log.error(`[watchdog] failed to send to ${s.chatId}:`, err?.message ?? err);
      }),
    ),
  );
  return true;
}

export async function alertWithCooldown(
  bot: Telegraf,
  key: string,
  message: string,
): Promise<boolean> {
  const lastSent = getAlertLastSent(key);
  if (lastSent && Date.now() - lastSent.getTime() < config.alertCooldownMs) {
    return false;
  }
  const delivered = await broadcast(bot, message);
  if (delivered) markAlertSent(key);
  return delivered;
}

export async function alertRecovery(bot: Telegraf, key: string, message: string): Promise<boolean> {
  const lastSent = getAlertLastSent(key);
  if (!lastSent) return false;
  const delivered = await broadcast(bot, message);
  if (delivered) clearAlert(key);
  return delivered;
}
