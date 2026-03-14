'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const PokerGame = require('./game/PokerGame');

const fs = require('fs');
const app = express();

const HTTP_PORT  = parseInt(process.env.HTTP_PORT  || '3003');
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3448');

// Always start HTTP server
const httpServer = http.createServer(app);

// HTTPS: start if certs are present at /cred/server.key and /cred/server.crt
const CERT_KEY = '/cred/server.key';
const CERT_CRT = '/cred/server.crt';
const hasCerts = fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT);
let httpsServer = null;
if (hasCerts) {
  httpsServer = https.createServer(
    { key: fs.readFileSync(CERT_KEY), cert: fs.readFileSync(CERT_CRT) },
    app
  );
}

// Attach Socket.IO to both servers so WebSocket works on both ports
const io = new Server();
io.attach(httpServer);
if (httpsServer) io.attach(httpsServer);

const LANG = process.env.GAME_LANG || 'en';
const MSG = {
  en: { roomNotFound: 'Room not found', sessionExpired: 'Session expired',
        roomDissolved: 'Room closed', invalidSeat: 'Invalid seat',
        notHost: 'Host only' },
  zh: { roomNotFound: '房间不存在', sessionExpired: '会话已过期',
        roomDissolved: '房间已解散', invalidSeat: '无效座位',
        notHost: '只有房主才能设置' },
}[LANG] || {
  roomNotFound: 'Room not found', sessionExpired: 'Session expired',
  roomDissolved: 'Room closed', invalidSeat: 'Invalid seat',
  notHost: 'Host only'
};

app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  res.send(html.replace('</head>', `<script>window.GAME_LANG='${LANG}'</script></head>`));
});
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
// codeIndex: displayCode -> internalRoomCode (for join lookups; internal code never changes)
const codeIndex = new Map();
// sessions: playerId -> { roomCode, disconnectTimer }
const sessions = new Map();
// kickTimers: playerId -> setTimeout handle (5-min kick after standing while disconnected)
const kickTimers = new Map();

const GRACE_MS = 3 * 60 * 1000; // 3-minute grace period for reconnection

function genCode() {
  let code;
  do { code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0'); } while (rooms.has(code));
  return code;
}

// Generate a new display code that doesn't collide with any existing display or internal code
function genDisplayCode() {
  let code;
  do { code = String(Math.floor(Math.random() * 1000000)).padStart(6, '0'); }
  while (codeIndex.has(code) || rooms.has(code));
  return code;
}

const KICK_MS = 5 * 60 * 1000; // 5-minute kick after standing while disconnected

function kickDisconnectedPlayer(playerId, roomCode) {
  kickTimers.delete(playerId);
  const game = rooms.get(roomCode);
  if (!game) { sessions.delete(playerId); return; }

  // Only kick if still standing and still disconnected
  const standingP = game.standingPlayers.find(p => p.id === playerId);
  if (!standingP || !standingP.disconnected) return; // player reconnected or not standing

  // Transfer host to next connected player
  if (game.hostId === playerId) {
    const candidates = [...game.players, ...game.pendingPlayers, ...game.standingPlayers]
      .filter(p => p.id !== playerId && !p.disconnected);
    if (candidates.length > 0) {
      game.hostId = candidates[0].id;
      io.to(roomCode).emit('host_changed', { newHostId: game.hostId, newHostName: candidates[0].name });
    }
  }

  game.kickPlayer(playerId);
  sessions.delete(playerId);
  io.to(roomCode).emit('player_kicked', { playerId, name: standingP.name });

  // If the room is now completely empty (all players kicked/left), dissolve it
  const anyRemaining = game.players.length || game.pendingPlayers.length ||
    game.standingPlayers.length || game.brokeSpectators.length;
  if (!anyRemaining) { codeIndex.delete(game.displayCode); rooms.delete(roomCode); }
}

io.on('connection', (socket) => {
  let curRoom = null;
  let curPlayer = null;

  // ── Room list ────────────────────────────────────────────
  socket.on('get_rooms', () => {
    const list = [];
    for (const [, game] of rooms) {
      if (game.isPrivate) continue; // private rooms are hidden
      const total = game.players.length + game.pendingPlayers.length + game.standingPlayers.length;
      if (total === 0 || total >= 9) continue;
      const host = game.players.find(p => p.id === game.hostId);
      list.push({
        code: game.displayCode,
        playerCount: total,
        hostName: host?.name || '',
        inProgress: game.phase !== 'waiting',
      });
    }
    socket.emit('rooms_list', list);
  });

  // ── Create room ──────────────────────────────────────────
  socket.on('create_room', ({ name }, cb) => {
    const code = genCode();
    const game = new PokerGame(code, io);
    rooms.set(code, game);
    codeIndex.set(code, code); // displayCode -> internalCode (initially same)

    // Set up callback: when a player is auto-stood-up due to disconnect, start 5-min kick timer
    game.onPlayerAutoStoodUp = (playerId) => {
      clearTimeout(kickTimers.get(playerId));
      kickTimers.set(playerId, setTimeout(() => kickDisconnectedPlayer(playerId, code), KICK_MS));
    };

    // Use a persistent UUID, not socket.id
    const pid = crypto.randomUUID();
    const res = game.addPlayer(pid, name, socket.id);
    if (res.error) { codeIndex.delete(code); rooms.delete(code); return cb({ error: res.error }); }

    game.hostId = pid;
    curRoom = code;
    curPlayer = pid;
    sessions.set(pid, { roomCode: code, disconnectTimer: null });

    socket.join(code);
    cb({ ok: true, roomCode: code, displayCode: game.displayCode, playerId: pid });
    io.to(code).emit('room_update', game._publicRoomInfo());
  });

  // ── Join room ────────────────────────────────────────────
  socket.on('join_room', ({ name, roomCode }, cb) => {
    // Resolve display code -> internal code via codeIndex
    const internalCode = codeIndex.get(roomCode);
    if (!internalCode) return cb({ error: MSG.roomNotFound });
    const game = rooms.get(internalCode);
    if (!game) return cb({ error: MSG.roomNotFound });

    const pid = crypto.randomUUID();
    let spectator = false;

    if (game.phase === 'waiting') {
      // Normal join before game starts
      const res = game.addPlayer(pid, name, socket.id);
      if (res.error) return cb({ error: res.error });
    } else {
      // Mid-game: join as standing spectator, must choose seat before entering
      const res = game.addPendingPlayer(pid, name, socket.id);
      if (res.error) return cb({ error: res.error });
      spectator = true;
    }

    curRoom = internalCode;
    curPlayer = pid;
    sessions.set(pid, { roomCode: internalCode, disconnectTimer: null });

    socket.join(internalCode);
    cb({ ok: true, roomCode: internalCode, displayCode: game.displayCode, playerId: pid, spectator });
    io.to(internalCode).emit('room_update', game._publicRoomInfo());

    // Send current game state immediately to spectators
    if (spectator) socket.emit('game_state', game._stateFor(pid));
  });

  // ── Rejoin (reconnect / refresh) ─────────────────────────
  socket.on('rejoin_room', ({ playerId, roomCode }, cb) => {
    const session = sessions.get(playerId);
    if (!session || session.roomCode !== roomCode) {
      return cb({ error: MSG.sessionExpired });
    }

    const game = rooms.get(roomCode);
    if (!game) {
      sessions.delete(playerId);
      return cb({ error: MSG.roomDissolved });
    }

    // Cancel the pending removal timer
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = null;
    }

    // Cancel any pending standing kick timer
    if (kickTimers.has(playerId)) {
      clearTimeout(kickTimers.get(playerId));
      kickTimers.delete(playerId);
    }

    // Restore socket binding — check active, pending, standing, and broke spectator pools
    const player = game.players.find(p => p.id === playerId)
                || game.pendingPlayers.find(p => p.id === playerId)
                || game.standingPlayers.find(p => p.id === playerId)
                || game.brokeSpectators.find(p => p.id === playerId);
    if (player) {
      player.socketId = socket.id;
      if ('disconnected' in player) player.disconnected = false;
    }

    curRoom = roomCode;
    curPlayer = playerId;
    socket.join(roomCode);

    if (game.phase === 'waiting') {
      cb({ ok: true, phase: 'waiting', roomCode, displayCode: game.displayCode, playerId, spectator: false });
      io.to(roomCode).emit('room_update', game._publicRoomInfo());
    } else {
      const isSpectator = !game.players.find(p => p.id === playerId);
      cb({ ok: true, phase: game.phase, roomCode, displayCode: game.displayCode, playerId, spectator: isSpectator });
      socket.emit('game_state', game._stateFor(playerId));
    }
  });

  // ── Leave room (waiting room only) ──────────────────────
  socket.on('leave_room', (cb) => {
    if (!curRoom || !curPlayer) return cb?.({ ok: true });
    const session = sessions.get(curPlayer);
    if (session?.disconnectTimer) clearTimeout(session.disconnectTimer);
    // Cancel kick timer if leaving voluntarily
    if (kickTimers.has(curPlayer)) {
      clearTimeout(kickTimers.get(curPlayer));
      kickTimers.delete(curPlayer);
    }
    sessions.delete(curPlayer);

    const game = rooms.get(curRoom);
    if (game) {
      game.removePlayer(curPlayer);
      // Transfer host to next active player
      if (game.hostId === curPlayer) {
        const next = game.players.find(p => !p.disconnected);
        if (next) game.hostId = next.id;
      }
      const remaining = game.players.filter(p => !p.disconnected);
      if (remaining.length > 0) io.to(curRoom).emit('room_update', game._publicRoomInfo());
      else { codeIndex.delete(game.displayCode); rooms.delete(curRoom); }
    }

    socket.leave(curRoom);
    curRoom = null;
    curPlayer = null;
    cb?.({ ok: true });
  });

  // ── Start game ───────────────────────────────────────────
  socket.on('start_game', (cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: MSG.roomNotFound });
    const res = game.startGame(curPlayer);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
  });

  // ── Show cards (winner voluntarily reveals after everyone folds) ─────────
  socket.on('show_cards', (cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: MSG.roomNotFound });
    const res = game.handleShowCards(curPlayer);
    if (res?.error) cb?.({ error: res.error });
    else cb?.({ ok: true });
  });

  // ── Room configuration (host only, before game starts) ──────────────────────
  socket.on('configure_room', (data, cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: MSG.roomNotFound });
    const { startingChips, bigBlind, maxBuyIn, isPrivate } = data || {};

    // Handle isPrivate toggle (managed here, not inside game.configure)
    if (isPrivate !== undefined) {
      if (game.hostId !== curPlayer) return cb?.({ error: MSG.notHost });
      const makePrivate = !!isPrivate;
      if (makePrivate !== game.isPrivate) {
        if (makePrivate) {
          // Switching to private: replace display code so old code becomes invalid
          codeIndex.delete(game.displayCode);
          const newCode = genDisplayCode();
          codeIndex.set(newCode, curRoom);
          game.displayCode = newCode;
        }
        game.isPrivate = makePrivate;
      }
    }

    const res = game.configure(curPlayer, { startingChips, bigBlind, maxBuyIn });
    if (res?.error) return cb?.({ error: res.error });
    io.to(curRoom).emit('room_update', game._publicRoomInfo());
    cb?.({ ok: true });
  });

  // ── Buy in (player with 0 chips between hands) ────────────────────────────
  socket.on('buy_in', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: MSG.roomNotFound });
    const res = game.buyIn(curPlayer, data?.amount);
    if (res?.error) cb?.({ error: res.error });
    else cb?.({ ok: true });
  });

  // ── Sit down (choose a seat) ──────────────────────────────────────────────
  socket.on('sit_down', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: MSG.roomNotFound });
    const seatIndex = parseInt(data?.seatIndex);
    if (isNaN(seatIndex)) return cb?.({ error: MSG.invalidSeat });
    const res = game.sitDown(curPlayer, seatIndex);
    if (res?.error) return cb?.({ error: res.error });
    io.to(curRoom).emit('room_update', game._publicRoomInfo());
    cb?.({ ok: true });
  });

  // ── Stand up (leave seat) ─────────────────────────────────────────────────
  socket.on('stand_up', (cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: MSG.roomNotFound });
    const res = game.standUp(curPlayer);
    if (res?.error) return cb?.({ error: res.error });
    io.to(curRoom).emit('room_update', game._publicRoomInfo());
    cb?.({ ok: true });
  });

  // ── Request end game (host only) ──────────────────────────────────────────
  socket.on('request_end_game', (cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: MSG.roomNotFound });
    const res = game.requestEndGame(curPlayer);
    if (res?.error) cb?.({ error: res.error });
    else cb?.({ ok: true });
  });

  // ── Player action ────────────────────────────────────────
  socket.on('action', ({ action, amount }, cb) => {
    const game = rooms.get(curRoom);
    if (!game) return;
    const res = game.handleAction(curPlayer, action, amount || 0);
    if (res?.error) cb?.({ error: res.error });
    else cb?.({ ok: true });
  });

  // ── Emoji ─────────────────────────────────────────────────
  socket.on('send_emoji', ({ emoji }) => {
    if (!curRoom || !curPlayer) return;
    const game = rooms.get(curRoom);
    if (!game) return;
    const allP = [...game.players, ...game.pendingPlayers, ...game.standingPlayers];
    const p = allP.find(q => q.id === curPlayer);
    if (!p) return;
    io.to(curRoom).emit('emoji_msg', { playerId: curPlayer, name: p.name, emoji });
  });

  // ── Chat ──────────────────────────────────────────────────
  socket.on('chat_msg', ({ text }) => {
    if (!curRoom || !curPlayer) return;
    if (typeof text !== 'string') return;
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    const game = rooms.get(curRoom);
    if (!game) return;
    const allP = [...game.players, ...game.pendingPlayers, ...game.standingPlayers];
    const p = allP.find(q => q.id === curPlayer);
    if (!p) return;
    io.to(curRoom).emit('chat_msg', { playerId: curPlayer, name: p.name, text: msg });
  });

  // ── Voice channel (server-relay PCM) ─────────────────────
  socket.on('voice_data', (data) => {
    if (!curRoom || !curPlayer) return;
    socket.to(curRoom).emit('voice_data', { fromPlayerId: curPlayer, data });
  });

  socket.on('voice_speaking', ({ speaking }) => {
    if (!curRoom || !curPlayer) return;
    socket.to(curRoom).emit('voice_speaking', { playerId: curPlayer, speaking: !!speaking });
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!curRoom || !curPlayer) return;
    const session = sessions.get(curPlayer);
    if (!session) return;

    const game = rooms.get(curRoom);
    if (!game) return;

    // Mark disconnected: for active players, just sets p.disconnected=true so the 30s
    // turn timer handles auto-action. Standing/pending/broke players are removed silently.
    game.markDisconnected(curPlayer);

    // Grace period: if they reconnect within 3 min, session is restored.
    // For mid-game players, the standing kick timer (5 min) handles final cleanup.
    session.disconnectTimer = setTimeout(() => {
      // Don't delete session if a standing kick timer is still pending
      // (player needs to be able to reconnect until kick fires)
      if (kickTimers.has(curPlayer)) return;

      sessions.delete(curPlayer);

      // For waiting room: actually remove the player slot
      if (game.phase === 'waiting') {
        game.removePlayer(curPlayer);
        if (game.hostId === curPlayer) {
          const next = game.players.find(p => !p.disconnected);
          if (next) {
            game.hostId = next.id;
            io.to(curRoom).emit('room_update', game._publicRoomInfo());
          }
        }
        const remaining = game.players.filter(p => !p.disconnected);
        if (remaining.length === 0) { codeIndex.delete(game.displayCode); rooms.delete(curRoom); }
      }
      // Mid-game: player stays connected to game logic; standing kick timer handles final removal.
      // Special case: waitingForBuyIn (only 1 player left, no active hand) — dissolve if no one remains
      if (game.waitingForBuyIn) {
        const anyConnected = [...game.players, ...game.pendingPlayers, ...game.standingPlayers]
          .some(p => !p.disconnected);
        if (!anyConnected) { codeIndex.delete(game.displayCode); rooms.delete(curRoom); }
      }
    }, GRACE_MS);
  });
});

httpServer.listen(HTTP_PORT, () => console.log(`Texas Hold'em HTTP  → http://localhost:${HTTP_PORT}`));
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => console.log(`Texas Hold'em HTTPS → https://localhost:${HTTPS_PORT}`));
}
