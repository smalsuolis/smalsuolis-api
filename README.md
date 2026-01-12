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

## Contributing

Contributions are welcome! If you find any issues or have suggestions for improvements, please open an issue or submit a
pull request. For more information, see the [contribution guidelines](./CONTRIBUTING.md).

## License

This project is licensed under the [MIT License](./LICENSE).
