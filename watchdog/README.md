# smalsuolis-watchdog

Telegram alerting bot that monitors the Smalsuolis API and notifies subscribers when something breaks.

## What it watches

- **Liveness** — polls `GET /health` every ~2.5 min. After 2 consecutive failures (≈5 min down) it alerts. Per-service status (postgres / redis / auth api) is included in the alert when `/health` responds but is degraded.
- **Integration freshness** — polls `GET /integrations/last-update` hourly. If any app hasn't had new events for more than 7 days, alerts.
- Sends a recovery message when things come back.

## Running locally

Prereqs: node 20, a Telegram bot token (ask @BotFather), a password for subscribers.

```bash
cp ../.env.example ../.env   # if you haven't already
# fill in TELEGRAM_BOT_TOKEN, TELEGRAM_SUBSCRIBE_PASSWORD, WATCHDOG_API_URL
cd watchdog
yarn install
yarn dev
```

In Telegram, DM the bot:

```
/subscribe <password>
/status
```

## Running in production

The watchdog ships alongside the API on every production release. See the parent [README](../README.md#production-deployment) for the full pipeline. Short version:

1. [`.github/workflows/deploy-production.yml`](../.github/workflows/deploy-production.yml) builds `./watchdog/Dockerfile` and pushes `ghcr.io/smalsuolis/smalsuolis-watchdog:production`.
2. The prod VPS's docker-compose file runs it as a service alongside `smalsuolis-api`.

### Compose service block

The block that lives in `/home/deploy/production/docker-compose.yml` on the VPS:

```yaml
smalsuolis-watchdog:
  image: ghcr.io/smalsuolis/smalsuolis-watchdog:${ENVIRONMENT:?err}
  pull_policy: always
  platform: linux/amd64
  restart: unless-stopped
  depends_on:
    - smalsuolis-api
  networks:
    - public-network
  environment:
    WATCHDOG_API_URL: http://smalsuolis-api:3000
    WATCHDOG_TIMEZONE: Europe/Vilnius
    TELEGRAM_BOT_TOKEN: ${INPUT_TELEGRAM_BOT_TOKEN:?err}
    TELEGRAM_SUBSCRIBE_PASSWORD: ${INPUT_TELEGRAM_SUBSCRIBE_PASSWORD:?err}
  volumes:
    - watchdog_data:/app/data
  deploy:
    resources:
      limits:
        memory: 256M
      reservations:
        memory: 64M
```

Plus `watchdog_data:` added to the top-level `volumes:` section.

### Secrets

`INPUT_TELEGRAM_BOT_TOKEN` and `INPUT_TELEGRAM_SUBSCRIBE_PASSWORD` live in `/home/deploy/production/.env` on the VPS (docker-compose auto-loads it from the same directory). The SQLite DB persists across redeploys in the `watchdog_data` named volume, so the subscriber list survives.

## Notes

- Alerts are deduped per key with a 6h cooldown for the same problem. State changes (new service goes down, another recovers) bypass cooldown and send immediately.
- The 2-consecutive-failures threshold on liveness absorbs short deploy downtime (~5 min window) so redeploys don't page.
- `broadcast()` only persists alert-sent state when at least one subscriber actually receives the message — so the very first subscriber still gets pending alerts after joining.
- The watchdog runs outside the API process on purpose — if it lived inside, it couldn't tell you when the API dies.
