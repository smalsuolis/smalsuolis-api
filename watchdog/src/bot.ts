import { Telegraf } from 'telegraf';
import { config } from './config';
import { addSubscriber, isSubscribed, removeSubscriber, subscriberCount } from './db';
import { manualIntegrationsStatus, manualStatus } from './checks';
import { log } from './logger';

export function createBot(): Telegraf {
  const bot = new Telegraf(config.botToken);

  bot.command('subscribe', async (ctx) => {
    const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
    if (arg !== config.subscribePassword) return;

    const chatId = ctx.chat.id;
    const username = ctx.from?.username ?? null;
    const added = addSubscriber(chatId, username);
    await ctx.reply(
      added
        ? `Subscribed. You'll get alerts here. (${subscriberCount()} subscriber(s) total)`
        : 'Already subscribed.',
    );
  });

  bot.start(async (ctx) => {
    if (!isSubscribed(ctx.chat.id)) return;
    await ctx.reply(
      [
        'Commands:',
        '/unsubscribe — stop getting alerts',
        '/status — current API health',
        '/integrations — when each integration last synced',
      ].join('\n'),
    );
  });

  bot.command('unsubscribe', async (ctx) => {
    if (!isSubscribed(ctx.chat.id)) return;
    removeSubscriber(ctx.chat.id);
    await ctx.reply('Unsubscribed.');
  });

  bot.command('status', async (ctx) => {
    if (!isSubscribed(ctx.chat.id)) return;
    const msg = await manualStatus();
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('integrations', async (ctx) => {
    if (!isSubscribed(ctx.chat.id)) return;
    const msg = await manualIntegrationsStatus();
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.catch((err, ctx) => {
    log.error(`bot error in update ${ctx.update?.update_id}:`, err);
  });

  return bot;
}
