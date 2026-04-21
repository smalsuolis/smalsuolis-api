import { config } from './config';
import { initDb } from './db';
import { createBot } from './bot';
import { startLoops } from './checks';
import { log } from './logger';

async function main() {
  initDb();
  const bot = createBot();
  startLoops(bot);

  await bot.launch();
  // Register the "/" command menu so users see a clickable list of available
  // commands in their Telegram client. Fire-and-forget — if Telegram is flaky
  // or the token's wrong we still want the bot to run and attempt polling.
  bot.telegram
    .setMyCommands([
      { command: 'subscribe', description: 'Start receiving alerts (needs password)' },
      { command: 'status', description: 'Current API + services health' },
      { command: 'integrations', description: 'When each integration last synced' },
      { command: 'unsubscribe', description: 'Stop receiving alerts' },
    ])
    .catch((err) => log.warn('setMyCommands failed:', err?.message ?? err));

  log.info(
    `running — polling ${config.apiBaseUrl} every ${Math.round(
      config.livenessIntervalMs / 1000,
    )}s, alerting after ${config.livenessFailuresBeforeAlert} consecutive failures`,
  );

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
