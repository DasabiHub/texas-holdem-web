# Texas Hold'em Poker

A lightweight, real-time multiplayer Texas Hold'em poker game playable in the browser. Designed to feel like a native app on mobile devices.

## Features

- **Real-time multiplayer** — up to 8 players per room via WebSocket
- **Mobile-first UI** — optimized for phone browsers, no app install needed
- **Room system** — create a room and share the 6-character code with friends, or browse open rooms
- **Full poker rules** — blinds, betting rounds, side pots, all-in, showdown
- **Turn timer** — 30-second countdown per player, auto-fold on timeout
- **Buy-in system** — configurable buy-in amount per room; broke players spectate and can re-buy at any time
- **Reconnection** — 3-minute grace period to reconnect without losing your seat
- **Showdown display** — reveals each player's best 5-card hand with hole cards highlighted
- **Host controls** — end the game at any time; final leaderboard shows net profit/loss for all players

## Quick Start

### Run with Docker

```bash
docker run -d -p 3448:3448 --restart unless-stopped your_real_username/texas-holdem:latest
```

Then open `http://localhost:3448` in your browser.

### Run with Docker Compose

Create a `docker-compose.yml`:

```yaml
services:
  texas-holdem:
    image: your_real_username/texas-holdem:latest
    ports:
      - "3448:3448"
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Run from Source

```bash
git clone <repo-url>
cd texas-holdem
npm install
node server.js
```

## How to Play

1. Open the app and enter your nickname
2. **Create** a room — share the room code with friends
3. Host sets the buy-in limit, then clicks **Start Game**
4. Players joining mid-game enter as spectators and join the next hand automatically
5. When chips run out, click **Buy In** to re-enter the next hand
6. The host can end the game at any time; final standings show each player's profit/loss

## Tech Stack

- **Runtime**: Node.js
- **Server**: Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JS (single file, no framework)
- **Docker base image**: `node:20-alpine`

## Ports

| Port | Description |
|------|-------------|
| 3448 | HTTP web interface |
