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
