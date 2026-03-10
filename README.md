[English](./README.md) · [中文](./README.zh.md)

# Texas Hold'em ♠

![UI Example](./UI_example.png)

Real-time multiplayer Texas Hold'em poker in the browser. No account needed — share a 6-character room code and start playing.

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
    build: .
    ports:
      - "3448:3448"
    environment:
      - PORT=3448
      - GAME_LANG=en   # en (default) | zh
    restart: unless-stopped
```

```bash
docker compose up -d
# Open http://localhost:3448
```

## Run from Source

```bash
npm install
node server.js               # English
GAME_LANG=zh node server.js  # Chinese
```

## PWA Install

On mobile, tap **Share → Add to Home Screen** (iOS) or the browser install prompt (Android/Chrome).

## Stack

Node.js · Express · Socket.IO · Vanilla JS (no framework)
