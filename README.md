[English](./README.md) · [中文](./README.zh.md)

# Texas Hold'em ♠

![UI Example](./UI_example.png)

Real-time multiplayer Texas Hold'em poker in the browser. No account needed — share a 6-digit room code and start playing.

## Features

- Up to 9 players per room, spectator support
- Full rules: blinds, side pots, all-in, turn timer, reconnection grace period
- Buy-in system with configurable limits per room
- Bilingual UI — English (default) or Chinese (`GAME_LANG=zh`)
- **PWA** — installable on iOS & Android, works offline after first load

## Docker Compose

```yaml
services:
  texas-holdem:
    image: dasabihub/texas-holdem-web:latest
    ports:
      - "3003:3003"   # HTTP
      - "3448:3448"   # HTTPS
    volumes:
      - /path/to/certs:/cred:ro   # optional, see HTTPS section below
    environment:
      - GAME_LANG=en   # en (default) | zh
    restart: unless-stopped
```

```bash
docker compose up -d
# HTTP:  http://localhost:3003
# HTTPS: https://localhost:3448  (only if certs are mounted)
```

## HTTPS

HTTPS is enabled automatically when certificate files are found at `/cred/server.key` and `/cred/server.crt` inside the container. Mount your certificate directory as a read-only volume:

```yaml
volumes:
  - /etc/ssl/my-certs:/cred:ro
```

The directory must contain exactly these two files:

```
server.key   # private key
server.crt   # certificate (include full chain if needed)
```

If no certs are found, the server runs HTTP only on port 3003 and HTTPS port 3448 is unused.

## Run from Source

```bash
npm install
node server.js               # English, HTTP only
GAME_LANG=zh node server.js  # Chinese, HTTP only
```

For HTTPS from source, place `server.key` and `server.crt` in `/cred/` on your machine, then run normally.

## PWA Install

On mobile, tap **Share → Add to Home Screen** (iOS) or the browser install prompt (Android/Chrome).

## Stack

Node.js · Express · Socket.IO · Vanilla JS (no framework)
