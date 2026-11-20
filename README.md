# Ollashare

Ollashare is a collaborative browser-based screen-sharing platform with host-controlled rooms, guest invitations, annotations, chat, local browser recording/download, Shared Browser integration, authentication, and a secure Electron desktop wrapper.

## Included

- Next.js frontend applications
- Convex backend functions, schema, authentication, and tests
- Shared UI, analytics, email, and logging packages
- Electron desktop wrapper source
- Browser-only recording and acceptance tooling
- Unit and integration tests

## Not included

VM-specific deployment files, service units, private network details, runtime credentials, environment files, generated builds, archives, and production evidence are intentionally excluded.

## Setup

1. Install Bun.
2. Run `bun install`.
3. Copy the relevant `.env.example` files to local `.env` files and provide your own credentials and public origins.
4. Run `bun dev:app` for the primary application.
5. Run `bun --filter @v1/desktop dev` to launch the Electron wrapper against the configured application URL.

Never commit production credentials or private infrastructure details.
