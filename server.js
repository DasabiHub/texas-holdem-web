'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const PokerGame = require('./game/PokerGame');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
// sessions: playerId -> { roomCode, disconnectTimer }
const sessions = new Map();

const GRACE_MS = 3 * 60 * 1000; // 3-minute grace period for reconnection

function genCode() {
  let code;
  do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  let curRoom = null;
  let curPlayer = null;

  // ── Room list ────────────────────────────────────────────
  socket.on('get_rooms', () => {
    const list = [];
    for (const [code, game] of rooms) {
      const total = game.players.length + game.pendingPlayers.length;
      if (total === 0 || total >= 8) continue;
      const host = game.players.find(p => p.id === game.hostId);
      list.push({
        code,
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

    // Use a persistent UUID, not socket.id
    const pid = crypto.randomUUID();
    const res = game.addPlayer(pid, name, socket.id);
    if (res.error) { rooms.delete(code); return cb({ error: res.error }); }

    game.hostId = pid;
    curRoom = code;
    curPlayer = pid;
    sessions.set(pid, { roomCode: code, disconnectTimer: null });

    socket.join(code);
    cb({ ok: true, roomCode: code, playerId: pid });
    io.to(code).emit('room_update', game._publicRoomInfo());
  });

  // ── Join room ────────────────────────────────────────────
  socket.on('join_room', ({ name, roomCode }, cb) => {
    const game = rooms.get(roomCode);
    if (!game) return cb({ error: '房间不存在' });

    const pid = crypto.randomUUID();
    let spectator = false;

    if (game.phase === 'waiting') {
      // Normal join before game starts
      const res = game.addPlayer(pid, name, socket.id);
      if (res.error) return cb({ error: res.error });
    } else {
      // Mid-game: join as pending spectator, enter at next hand
      const res = game.addPendingPlayer(pid, name, socket.id);
      if (res.error) return cb({ error: res.error });
      spectator = true;
    }

    curRoom = roomCode;
    curPlayer = pid;
    sessions.set(pid, { roomCode, disconnectTimer: null });

    socket.join(roomCode);
    cb({ ok: true, roomCode, playerId: pid, spectator });
    io.to(roomCode).emit('room_update', game._publicRoomInfo());

    // Send current game state immediately to spectators
    if (spectator) socket.emit('game_state', game._stateFor(pid));
  });

  // ── Rejoin (reconnect / refresh) ─────────────────────────
  socket.on('rejoin_room', ({ playerId, roomCode }, cb) => {
    const session = sessions.get(playerId);
    if (!session || session.roomCode !== roomCode) {
      return cb({ error: '会话已过期' });
    }

    const game = rooms.get(roomCode);
    if (!game) {
      sessions.delete(playerId);
      return cb({ error: '房间已解散' });
    }

    // Cancel the pending removal timer
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      session.disconnectTimer = null;
    }

    // Restore socket binding — check active, pending, and broke spectator pools
    const player = game.players.find(p => p.id === playerId)
                || game.pendingPlayers.find(p => p.id === playerId)
                || game.brokeSpectators.find(p => p.id === playerId);
    if (player) {
      player.socketId = socket.id;
      if ('disconnected' in player) player.disconnected = false;
    }

    curRoom = roomCode;
    curPlayer = playerId;
    socket.join(roomCode);

    if (game.phase === 'waiting') {
      cb({ ok: true, phase: 'waiting', roomCode, playerId, spectator: false });
      io.to(roomCode).emit('room_update', game._publicRoomInfo());
    } else {
      const isSpectator = !game.players.find(p => p.id === playerId);
      cb({ ok: true, phase: game.phase, roomCode, playerId, spectator: isSpectator });
      socket.emit('game_state', game._stateFor(playerId));
    }
  });

  // ── Leave room (waiting room only) ──────────────────────
  socket.on('leave_room', (cb) => {
    if (!curRoom || !curPlayer) return cb?.({ ok: true });
    const session = sessions.get(curPlayer);
    if (session?.disconnectTimer) clearTimeout(session.disconnectTimer);
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
      else rooms.delete(curRoom);
    }

    socket.leave(curRoom);
    curRoom = null;
    curPlayer = null;
    cb?.({ ok: true });
  });

  // ── Start game ───────────────────────────────────────────
  socket.on('start_game', (cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: '房间不存在' });
    const res = game.startGame(curPlayer);
    if (res.error) return cb?.({ error: res.error });
    cb?.({ ok: true });
  });

  // ── Show cards (winner voluntarily reveals after everyone folds) ─────────
  socket.on('show_cards', (cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: '房间不存在' });
    const res = game.handleShowCards(curPlayer);
    if (res?.error) cb?.({ error: res.error });
    else cb?.({ ok: true });
  });

  // ── Room configuration (host only, before game starts) ──────────────────────
  socket.on('configure_room', ({ maxBuyIn }, cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: '房间不存在' });
    const res = game.configure(curPlayer, { maxBuyIn });
    if (res?.error) return cb?.({ error: res.error });
    io.to(curRoom).emit('room_update', game._publicRoomInfo());
    cb?.({ ok: true });
  });

  // ── Buy in (player with 0 chips between hands) ────────────────────────────
  socket.on('buy_in', (data, cb) => {
    if (typeof data === 'function') { cb = data; data = {}; }
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: '房间不存在' });
    const res = game.buyIn(curPlayer, data?.amount);
    if (res?.error) cb?.({ error: res.error });
    else cb?.({ ok: true });
  });

  // ── Request end game (host only) ──────────────────────────────────────────
  socket.on('request_end_game', (cb) => {
    const game = rooms.get(curRoom);
    if (!game) return cb?.({ error: '房间不存在' });
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

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    if (!curRoom || !curPlayer) return;
    const session = sessions.get(curPlayer);
    if (!session) return;

    const game = rooms.get(curRoom);
    if (!game) return;

    // Temporary disconnect: fold them now but keep their seat & chips
    game.markDisconnected(curPlayer);

    // Grace period: if they reconnect within 3 min, session is restored
    // If not, clean up session (player stays in game auto-folding until chips run out)
    session.disconnectTimer = setTimeout(() => {
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
        if (game.players.filter(p => !p.disconnected).length === 0) rooms.delete(curRoom);
      }
      // Mid-game: player stays in game.players, auto-folded each hand,
      // bleeds out from blinds. Room cleans up naturally when all leave.
    }, GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Texas Hold'em running at http://localhost:${PORT}`));
