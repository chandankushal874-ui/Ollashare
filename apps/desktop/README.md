# Mira desktop wrapper

This workspace is a secure Electron shell for the existing Mira web application. It does not replace or modify the Next.js server deployment.

## Run locally

1. Start the web app with `bun dev:app` from the repository root.
2. Start Electron with `bun --filter @v1/desktop dev`.

The default URL is `http://127.0.0.1:3000`. Set `MIRA_DESKTOP_URL` to an HTTPS deployment URL when wrapping a remote environment.

## Security boundary

- Renderer sandbox enabled.
- Context isolation enabled.
- Node integration disabled.
- Navigation restricted to the configured application origin.
- New external HTTPS and mail links open in the operating-system browser.
- Camera, microphone, display-capture, notifications, and sanitized clipboard writes are allowed only for the configured application origin.
- No general-purpose IPC or filesystem API is exposed to the renderer.
