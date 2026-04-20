# Smalsuolis API

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/smalsuolis/smalsuolis-api/badge)](https://securityscorecards.dev/viewer/?platform=github.com&org={smalsuolis}&repo={smalsuolis-api})
[![License](https://img.shields.io/github/license/smalsuolis/smalsuolis-api)](https://github.com/smalsuolis/smalsuolis-api/blob/main/LICENSE)
[![GitHub issues](https://img.shields.io/github/issues/smalsuolis/smalsuolis-api)](https://github.com/smalsuolis/smalsuolis-api/issues)
[![GitHub stars](https://img.shields.io/github/stars/smalsuolis/smalsuolis-api)](https://github.com/smalsuolis/smalsuolis-api/stargazers)

This repository contains the source code and documentation for the Smalsuolis API, developed by the Smalsuolis.

## Table of Contents

- [About the Project](#about-the-project)
- [Getting Started](#getting-started)
  - [Installation](#installation)
  - [Usage](#usage)
- [OpenAPI](#openapi)
- [Deployment](#deployment)
- [Watchdog (Telegram alerting bot)](#watchdog-telegram-alerting-bot)
- [Contributing](#contributing)
- [License](#license)

## About the Project

The Smalsuolis API is designed to provide information and functionalities related to activities of different water bodies located in Lithuania. It aims to support the management of water bodies.

## Getting Started

To get started with the Smalsuolis API, follow the instructions below.

### Installation

Use Node v20 (`nvm use 20`) and Yarn v1 (classic).

1. Clone the repository:

   ```bash
   git clone https://github.com/smalsuolis/smalsuolis-api.git
   ```

2. Install the required dependencies:

   ```bash
   cd smalsuolis-api
   yarn install
   ```

### Usage

1. Start dependencies using Docker Compose:

   ```bash
   yarn dc:up
   ```

This will start `redis`, `chrome`, `postgres` (with two databases: `smalsuolis` and `auth`) and `auth` module.

2. (First time only) Prepare `.env` for `smalsuolis-api`.

   2.1. Copy `.env.example` to `.env`

   2.2. Get auth API_KEY. Connect to database `jdbc:postgresql://localhost:5112/smalsuolis`, you will see two databases here `auth` and `smalsuolis`, go to `auth` database, `apps` table, and copy `api_key` from the Admin app (should be first).

   2.3 `AUTH_API_KEY=` value to `.env`.

3. Start the API server:

   ```bash
   yarn dev
   ```

The API will be available at `http://localhost:3000`.

## Deployment

### Production

To deploy the application to the production environment, create a new GitHub release:

1. Go to the repository's main page on GitHub.
2. Click on the "Releases" tab.
3. Click on the "Create a new release" button.
4. Provide a version number, such as `1.2.3`, and other relevant information.
5. Click on the "Publish release" button.

### Staging

The `main` branch of the repository is automatically deployed to the staging environment. Any changes pushed to the main
branch will trigger a new deployment.

### Development

To deploy any branch to the development environment use the `Deploy to Development` GitHub action.

## Watchdog (Telegram alerting bot)

The `watchdog/` directory contains a small standalone Node service that monitors this API and alerts subscribers on Telegram when things break. It:

- pings the API's `/health` endpoint and reports per-service status (postgres, redis, auth api)
- polls `/integrations/last-update` and alerts when any integration's data goes stale (>7 days by default)
- persists subscribers + alert state in SQLite so redeploys don't lose them
- stays silent to non-subscribed users; subscribers authenticate with `/subscribe <password>`

Full runtime details + commands live in [`watchdog/README.md`](./watchdog/README.md).

### Production deployment

The watchdog runs **only in production**. It's built and shipped alongside the API on every tag release:

1. CI step in [`.github/workflows/deploy-production.yml`](./.github/workflows/deploy-production.yml) builds `./watchdog/Dockerfile` and pushes to `ghcr.io/smalsuolis/smalsuolis-watchdog:production`.
2. The prod VPS's compose file at `/home/deploy/production/docker-compose.yml` has a `smalsuolis-watchdog` service block referencing that image, attached to `public-network`, reaching the API via `http://smalsuolis-api:3000`, with a `watchdog_data` named volume for SQLite persistence across redeploys.
3. Two env vars (`INPUT_TELEGRAM_BOT_TOKEN`, `INPUT_TELEGRAM_SUBSCRIBE_PASSWORD`) live in `/home/deploy/production/.env` on the VPS, which docker-compose auto-loads.

### First-time setup checklist (for future migrations)

If moving the watchdog to a new environment or re-bootstrapping prod:

1. **Create a bot** via [@BotFather](https://t.me/BotFather) on Telegram and note the token.
2. **Pick a subscribe password** — subscribers need to supply it via `/subscribe <password>` to start receiving alerts.
3. **Add `smalsuolis-watchdog` service** to the target env's compose file (see `watchdog/README.md` for the block).
4. **Create `.env` next to the compose file** on the VPS:
   ```bash
   cat > /home/deploy/production/.env <<'EOF'
   INPUT_TELEGRAM_BOT_TOKEN=<token from @BotFather>
   INPUT_TELEGRAM_SUBSCRIBE_PASSWORD=<your password>
   EOF
   chmod 600 /home/deploy/production/.env
   ```
5. **Trigger a deploy** (tag a release, or manually `docker-compose pull && docker-compose up -d`). The watchdog container starts, bot goes online, DM it `/subscribe <password>` to begin receiving alerts.

### Why the hybrid `.env` + shell-env setup

Most API secrets (`INPUT_POSTMARK_KEY`, `INPUT_API_DB_CONNECTION`, etc.) are injected by the trigger-deploy workflow in a separate (non-public) repo. That workflow maps specific GitHub repo secrets to specific `INPUT_*` shell variables before running `docker-compose up -d`. Routing new secrets through that path requires editing the trigger-deploy repo.

For the watchdog's two values we chose the simpler route: a small `.env` file on the VPS that docker-compose auto-loads. Tradeoff: the values aren't rotatable from GitHub's UI. Fine for a bot token + internal password. If you ever want them GitHub-managed, add them to repo secrets AND update the trigger-deploy workflow to forward them as `INPUT_TELEGRAM_BOT_TOKEN` / `INPUT_TELEGRAM_SUBSCRIBE_PASSWORD`, then remove the `.env`.

## Contributing

Contributions are welcome! If you find any issues or have suggestions for improvements, please open an issue or submit a
pull request. For more information, see the [contribution guidelines](./CONTRIBUTING.md).

## License

This project is licensed under the [MIT License](./LICENSE).
