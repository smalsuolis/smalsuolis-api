import { Markup, Telegraf } from 'telegraf';
import { config } from './config';
import { addSubscriber, isSubscribed, removeSubscriber, subscriberCount } from './db';
import { manualIntegrationsStatus, manualStatus } from './checks';
import { log } from './logger';

// Persistent reply keyboard shown to subscribed users so they don't have to
// type slash-commands — they just tap. Labels are emoji + text; tapping sends
// that exact text back as a message, which we map to the corresponding
// command handler via bot.hears().
const BTN_STATUS = '📊 Status';
const BTN_INTEGRATIONS = '📅 Integrations';

const menu = Markup.keyboard([[BTN_STATUS, BTN_INTEGRATIONS]])
  .resize()
  .persistent();

const menuReplyMarkup = { reply_markup: menu.reply_markup };

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
      menuReplyMarkup,
    );
  });

  bot.start(async (ctx) => {
    if (!isSubscribed(ctx.chat.id)) return;
    await ctx.reply(
      ['Tap a button below, or use /status, /integrations, /unsubscribe.'].join('\n'),
      menuReplyMarkup,
    );
  });

  const handleStatus = async (ctx: any) => {
    if (!isSubscribed(ctx.chat.id)) return;
    const msg = await manualStatus();
    await ctx.reply(msg, { parse_mode: 'Markdown', ...menuReplyMarkup });
  };

  const handleIntegrations = async (ctx: any) => {
    if (!isSubscribed(ctx.chat.id)) return;
    const msg = await manualIntegrationsStatus();
    await ctx.reply(msg, { parse_mode: 'Markdown', ...menuReplyMarkup });
  };

  const handleUnsubscribe = async (ctx: any) => {
    if (!isSubscribed(ctx.chat.id)) return;
    removeSubscriber(ctx.chat.id);
    await ctx.reply('Unsubscribed.', Markup.removeKeyboard());
  };

  // Slash-command handlers (for users who type).
  bot.command('status', handleStatus);
  bot.command('integrations', handleIntegrations);
  bot.command('unsubscribe', handleUnsubscribe);

  // Tap-button handlers (for users who tap the persistent keyboard).
  bot.hears(BTN_STATUS, handleStatus);
  bot.hears(BTN_INTEGRATIONS, handleIntegrations);

  bot.catch((err, ctx) => {
    log.error(`bot error in update ${ctx.update?.update_id}:`, err);
  });

  return bot;
}
