'use strict';

const Deck = require('./Deck');
const { bestHand, compareEvals } = require('./HandEvaluator');

const PHASE = {
  WAITING: 'waiting',
  PREFLOP: 'preflop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
};

const TURN_TIME = 30; // seconds

class PokerGame {
  constructor(roomCode, io) {
    this.roomCode = roomCode;
    this.displayCode = roomCode; // what players see; can change when switching to private
    this.isPrivate = false;
    this.io = io;
    this.hostId = null;
    this.players = []; // [{ id, name, chips, socketId, totalBet, roundBet, folded, allIn, holeCards, lastAction, seatIndex }]
    this.pendingPlayers = []; // joined mid-game, waiting to enter at next hand
    this.standingPlayers = []; // players with a seat reserved but currently standing (not in active hand)
    this.phase = PHASE.WAITING;
    this.deck = null;
    this.communityCards = [];
    this.pot = 0;
    this.dealerIdx = 0;
    this.dealerSeatIndex = 0; // persists across hands even when player array changes
    this.currentIdx = -1;
    this.currentBet = 0;
    this.minRaise = 20;
    this.smallBlind = 10;
    this.bigBlind = 20;
    this.startingChips = 1000;
    this.playersToAct = []; // seat indices in order
    this.timer = null;
    this.timerDeadline = null;
    this.lastResult = null;
    this.maxBuyIn = 1000;
    this.pendingEnd = false;
    this.finalRankings = null;
    this.revealAll = false;       // true = real showdown (cards go to river), false = won by fold
    this.showCardsWinnerId = null; // winner who can voluntarily show cards
    this.showCardsTimer = null;
    this.brokeSpectators = []; // players with 0 chips watching until they buy back in
    this.waitingForBuyIn = false; // true when game can't start due to insufficient active players
    this.nextHandAt = null; // timestamp when next hand starts (for client countdown)
    this.handHistory = []; // [{handNum, communityCards, wonByFold, winners:[{name,holeCards,handName,netProfit}]}]
    this.handNum = 0;
    this.seats = new Array(9).fill(null); // seats[i] = playerId or null
    this._handStarting = false; // guard against concurrent _startHand() calls
    this._nextHandTimer = null; // single scheduled timer for next hand
    this.kickedPlayers = []; // players removed due to long disconnect while standing
    this.leftPlayers = []; // players who voluntarily left or disconnected mid-game (for final leaderboard)
    this.onPlayerAutoStoodUp = null; // callback(playerId) when player auto-moved to standing due to disconnect
  }

  // ── Player management ──────────────────────────────────────────────────────

  addPlayer(id, name, socketId) {
    const total = this.players.length + this.pendingPlayers.length + this.standingPlayers.length;
    if (total >= 9) return { error: '房间已满' };
    if (this.phase !== PHASE.WAITING) return { error: '游戏已开始' };
    if (this.players.find(p => p.name === name)) return { error: '昵称已被使用' };
    const player = {
      id, name, socketId,
      chips: this.startingChips,
      totalBet: 0, roundBet: 0,
      folded: false, allIn: false,
      holeCards: [], lastAction: null,
      totalLoaned: 0,
      seatIndex: null,
    };
    this.players.push(player);
    return { player };
  }

  // Join mid-game as spectator — will enter at next hand start after choosing a seat
  addPendingPlayer(id, name, socketId) {
    const total = this.players.length + this.pendingPlayers.length + this.standingPlayers.length;
    if (total >= 9) return { error: '房间已满' };
    const nameUsed = this.players.find(p => p.name === name) || this.pendingPlayers.find(p => p.name === name)
      || this.standingPlayers.find(p => p.name === name);
    if (nameUsed) return { error: '昵称已被使用' };
    const player = {
      id, name, socketId,
      chips: this.startingChips,
      totalBet: 0, roundBet: 0,
      folded: false, allIn: false,
      holeCards: [], lastAction: null,
      totalLoaned: 0,
      seatIndex: null,
    };
    // Start as standing player — they must choose a seat via sitDown()
    this.standingPlayers.push(player);
    return { player };
  }

  // Player chooses a seat
  sitDown(playerId, seatIndex) {
    if (seatIndex < 0 || seatIndex > 8) return { error: '无效座位' };
    if (this.seats[seatIndex] !== null) return { error: '座位已被占用' };

    // Find player in any pool
    const fromStanding = this.standingPlayers.find(p => p.id === playerId);
    const fromBroke = this.brokeSpectators.find(p => p.id === playerId);
    const fromActive = this._player(playerId); // in this.players (waiting phase)
    const fromPending = this.pendingPlayers.find(p => p.id === playerId);

    const p = fromStanding || fromBroke || fromActive || fromPending;
    if (!p) return { error: '玩家不存在' };
    if (p.seatIndex !== null) return { error: '你已经在座位上了' };

    // Clear old seat if any (shouldn't happen but safety check)
    this.seats[seatIndex] = playerId;
    p.seatIndex = seatIndex;

    if (fromStanding) {
      // Standing player with chips → move to pendingPlayers (enter next hand)
      this.standingPlayers.splice(this.standingPlayers.indexOf(fromStanding), 1);
      if (this.phase === PHASE.WAITING) {
        this.players.push(p);
      } else {
        this.pendingPlayers.push(p);
        // If game was waiting for buy-ins, check if we now have enough
        if (this.waitingForBuyIn) {
          const seated = this.players.filter(q => q.seatIndex !== null).length
            + this.pendingPlayers.filter(q => q.seatIndex !== null).length;
          if (seated >= 2) {
            this.waitingForBuyIn = false;
            this._scheduleNextHand(2000);
          }
        }
      }
    } else if (fromBroke) {
      // Broke spectator choosing a seat — still needs to buy in first; just record seat
      // They stay in brokeSpectators; once they buy in, they'll move to pendingPlayers
    }
    // fromActive: player was in this.players with pendingStandUp; cancel the stand-up
    if (fromActive) p.pendingStandUp = false;
    // fromPending: already in correct array, just update seatIndex

    this._broadcastState();
    return { ok: true };
  }

  // Player stands up (only when folded during a hand, or during waiting phase)
  standUp(playerId) {
    const p = this._player(playerId);
    if (!p) {
      // Check if in pendingPlayers or standingPlayers
      const pending = this.pendingPlayers.find(q => q.id === playerId);
      if (pending && pending.seatIndex !== null) {
        this.seats[pending.seatIndex] = null;
        pending.seatIndex = null;
        // Move from pendingPlayers to standingPlayers
        this.pendingPlayers.splice(this.pendingPlayers.indexOf(pending), 1);
        this.standingPlayers.push(pending);
        this._broadcastState();
        return { ok: true };
      }
      return { error: '玩家不存在' };
    }
    if (this.phase !== PHASE.WAITING && !p.folded) return { error: '只能在弃牌后站起' };
    if (this.phase === PHASE.SHOWDOWN) return { error: '摊牌阶段不能站起' };

    if (this.phase === PHASE.WAITING) {
      // In waiting phase, stand up immediately
      if (p.seatIndex !== null) {
        this.seats[p.seatIndex] = null;
        p.seatIndex = null;
      }
      // Move from players to standingPlayers
      const idx = this.players.indexOf(p);
      this.players.splice(idx, 1);
      this.standingPlayers.push(p);
      this._broadcastState();
      return { ok: true };
    }

    // During game: free seat immediately so others can sit, keep in players for pot tracking
    if (p.seatIndex !== null) {
      this.seats[p.seatIndex] = null;
      p.seatIndex = null;
    }
    p.pendingStandUp = true;
    this._broadcastState();
    return { ok: true };
  }

  // Called when player explicitly leaves — marks for removal at next hand (or immediately if waiting)
  removePlayer(id) {
    // Handle broke spectators
    const bi = this.brokeSpectators.findIndex(p => p.id === id);
    if (bi >= 0) {
      const p = this.brokeSpectators[bi];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.brokeSpectators.splice(bi, 1);
      if (!this.leftPlayers.find(q => q.id === p.id)) this.leftPlayers.push(p);
      this._broadcastState(); return;
    }

    // Handle standing players
    const si = this.standingPlayers.findIndex(p => p.id === id);
    if (si >= 0) {
      const p = this.standingPlayers[si];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.standingPlayers.splice(si, 1);
      if (!this.leftPlayers.find(q => q.id === p.id)) this.leftPlayers.push(p);
      this._broadcastState(); return;
    }

    // Handle pending (spectator) players first
    const pi = this.pendingPlayers.findIndex(p => p.id === id);
    if (pi >= 0) {
      const p = this.pendingPlayers[pi];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.pendingPlayers.splice(pi, 1);
      this._broadcastState(); return;
    }

    const p = this._player(id);
    if (!p) return;
    if (this.phase !== PHASE.WAITING) {
      p.folded = true;
      p.disconnected = true;
      p.permanentlyLeft = true;
      this.playersToAct = this.playersToAct.filter(idx => this.players[idx]?.id !== id);
      const cur = this.players[this.currentIdx];
      if (cur && cur.id === id) this._checkAdvance();
      else this._broadcastState();
    } else {
      const idx = this.players.indexOf(p);
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.players.splice(idx, 1);
    }
  }

  // Called on temporary disconnect — mark disconnected but let the turn timer handle auto-action
  markDisconnected(id) {
    // Broke spectators: remove and save for leaderboard
    const bi = this.brokeSpectators.findIndex(p => p.id === id);
    if (bi >= 0) {
      const p = this.brokeSpectators[bi];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.brokeSpectators.splice(bi, 1);
      if (!this.leftPlayers.find(q => q.id === p.id)) this.leftPlayers.push(p);
      return;
    }

    // Standing players: remove and save for leaderboard
    const si = this.standingPlayers.findIndex(p => p.id === id);
    if (si >= 0) {
      const p = this.standingPlayers[si];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.standingPlayers.splice(si, 1);
      if (!this.leftPlayers.find(q => q.id === p.id)) this.leftPlayers.push(p);
      return;
    }

    // Pending players: just remove them (they haven't joined a hand yet)
    const pi = this.pendingPlayers.findIndex(p => p.id === id);
    if (pi >= 0) {
      const p = this.pendingPlayers[pi];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.pendingPlayers.splice(pi, 1); return;
    }

    const p = this._player(id);
    if (!p || p.permanentlyLeft) return;
    p.disconnected = true;
    // Don't fold immediately — let the 30s turn timer auto-act for them.
    // Just broadcast so others see the disconnected indicator.
    this._broadcastState();
  }

  updateSocket(id, socketId) {
    const p = this._player(id)
      || this.pendingPlayers.find(p => p.id === id)
      || this.standingPlayers.find(p => p.id === id)
      || this.brokeSpectators.find(p => p.id === id);
    if (p) p.socketId = socketId;
  }

  // ── Game start ─────────────────────────────────────────────────────────────

  startGame(requesterId) {
    if (requesterId !== this.hostId) return { error: '只有房主才能开始游戏' };
    const seated = this.players.filter(p => p.seatIndex !== null);
    if (seated.length < 2) return { error: '至少需要2名玩家入座' };
    this._startHand();
    return { ok: true };
  }

  // Advance dealerSeatIndex to the next occupied seat after current dealer
  _advanceDealerSeat() {
    const curDealerSeat = this.players[this.dealerIdx]?.seatIndex ?? this.dealerSeatIndex;
    const occupiedSeats = this.players.map(p => p.seatIndex).filter(s => s !== null).sort((a, b) => a - b);
    this.dealerSeatIndex = occupiedSeats.find(s => s > curDealerSeat) ?? occupiedSeats[0] ?? 0;
  }

  // Centralized helper — prevents duplicate timers for next hand
  _scheduleNextHand(delayMs) {
    clearTimeout(this._nextHandTimer);
    this._nextHandTimer = setTimeout(() => {
      this._nextHandTimer = null;
      this._startHand();
    }, delayMs);
  }

  _startHand() {
    // Guard: ignore re-entrant calls (e.g. race between showdown timer and waitingForBuyIn timer)
    if (this._handStarting) return;
    this._handStarting = true;

    // Apply pending mid-game config changes
    if (this.pendingBigBlind) {
      this.bigBlind = this.pendingBigBlind;
      this.smallBlind = Math.max(1, Math.floor(this.pendingBigBlind / 2));
      this.pendingBigBlind = null;
    }
    if (this.pendingMaxBuyIn) {
      this.maxBuyIn = this.pendingMaxBuyIn;
      this.pendingMaxBuyIn = null;
    }

    this.deck = new Deck();
    this.communityCards = [];
    this.pot = 0;
    this.revealAll = false;
    this.showCardsWinnerId = null;
    this.waitingForBuyIn = false;
    clearTimeout(this.showCardsTimer);
    this.showCardsTimer = null;
    clearTimeout(this._nextHandTimer);
    this._nextHandTimer = null;

    // Handle pending stand-up players: clear their seat and move to standingPlayers
    const standingUp = this.players.filter(p => p.pendingStandUp);
    for (const p of standingUp) {
      if (p.seatIndex !== null) {
        this.seats[p.seatIndex] = null;
        p.seatIndex = null;
      }
      p.pendingStandUp = false;
      this.standingPlayers.push(p);
    }
    this.players = this.players.filter(p => !standingUp.includes(p));

    // Handle disconnected players who were auto-folded: move them to standingPlayers
    const autoStoodUp = this.players.filter(p => p.pendingStandUpDisconnected);
    for (const p of autoStoodUp) {
      if (p.seatIndex !== null) {
        this.seats[p.seatIndex] = null;
        p.seatIndex = null;
      }
      p.pendingStandUpDisconnected = false;
      this.standingPlayers.push(p);
      // Notify server.js to start the 5-minute kick timer
      if (this.onPlayerAutoStoodUp) this.onPlayerAutoStoodUp(p.id);
    }
    this.players = this.players.filter(p => !autoStoodUp.includes(p));

    // Absorb pending players (who have a seat) into the active roster
    const readyPending = this.pendingPlayers.filter(p => p.seatIndex !== null);
    for (const p of readyPending) this.players.push(p);
    this.pendingPlayers = this.pendingPlayers.filter(p => p.seatIndex === null);

    // Remove permanently-left players and clear their seats; save for final leaderboard
    const permanentlyLeft = this.players.filter(p => p.permanentlyLeft);
    for (const p of permanentlyLeft) {
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; p.seatIndex = null; }
      if (!this.leftPlayers.find(q => q.id === p.id)) this.leftPlayers.push(p);
    }

    // Move 0-chip players to brokeSpectators instead of removing them
    const nowBroke = this.players.filter(p => !p.permanentlyLeft && p.chips === 0);
    for (const p of nowBroke) {
      if (!this.brokeSpectators.find(b => b.id === p.id)) {
        // Clear their seat since they went broke
        if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; p.seatIndex = null; }
        this.brokeSpectators.push(p);
      }
    }
    this.players = this.players.filter(p => !p.permanentlyLeft && p.chips > 0);

    // Players without seats go to standingPlayers (shouldn't normally happen but safety)
    const unseated = this.players.filter(p => p.seatIndex === null);
    for (const p of unseated) this.standingPlayers.push(p);

    // Only players with seats participate
    this.players = this.players.filter(p => p.seatIndex !== null);

    // Sort players by seatIndex (counterclockwise order)
    this.players.sort((a, b) => a.seatIndex - b.seatIndex);

    // Check if host requested game end
    if (this.pendingEnd) {
      this._handStarting = false;
      this._finalLeaderboard();
      return;
    }

    // Not enough active players — wait for buy-ins (don't kick to lobby)
    if (this.players.length < 2) {
      this._handStarting = false;
      this.waitingForBuyIn = true;
      this.lastResult = this.lastResult; // preserve last result for display
      this._broadcastState();
      return;
    }

    this.lastResult = null;
    this.nextHandAt = null;

    // Reset per-hand player state
    for (const p of this.players) {
      p.holeCards = [];
      p.totalBet = 0;
      p.roundBet = 0;
      p.folded = false; // disconnected players start unfolded — timer handles their auto-action
      p.allIn = false;
      p.lastAction = null;
      p.showedCards = false;
    }

    const n = this.players.length;

    // Find dealer index based on dealerSeatIndex (find closest seat >= dealerSeatIndex)
    let dealerIdx = 0;
    let found = false;
    for (let i = 0; i < n; i++) {
      if (this.players[i].seatIndex >= this.dealerSeatIndex) {
        dealerIdx = i; found = true; break;
      }
    }
    if (!found) dealerIdx = 0; // wrap around: use first player
    this.dealerIdx = dealerIdx;

    // Determine SB and BB (heads-up: dealer = SB; 3+: SB left of dealer, BB two left)
    const sbIdx = n === 2 ? this.dealerIdx : (this.dealerIdx + 1) % n;
    const bbIdx = (sbIdx + 1) % n;

    // Deal hole cards
    for (const p of this.players) {
      p.holeCards = this.deck.deal(2);
    }

    // Post blinds
    this._postBlind(sbIdx, this.smallBlind);
    this._postBlind(bbIdx, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    this.phase = PHASE.PREFLOP;

    // Preflop: action starts from UTG (after BB)
    const utg = (bbIdx + 1) % n;
    this._buildActionQueue(utg);
    // BB gets option at end – they're already at the back of the queue
    this._handStarting = false; // hand setup complete; allow future _startHand calls
    this._startTimer();
    this._broadcastState();
  }

  _postBlind(idx, amount) {
    const p = this.players[idx];
    const actual = Math.min(amount, p.chips);
    p.chips -= actual;
    p.roundBet = actual;
    p.totalBet = actual;
    this.pot += actual;
    if (p.chips === 0) p.allIn = true;
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  handleAction(playerId, action, amount) {
    if (this.phase === PHASE.WAITING || this.phase === PHASE.SHOWDOWN) return { error: '不在行动阶段' };
    const p = this._player(playerId);
    if (!p) return { error: '玩家不存在' };
    const currentP = this.players[this.currentIdx];
    if (!currentP || currentP.id !== playerId) return { error: '还没轮到你' };
    if (p.folded) return { error: '已弃牌' };

    clearTimeout(this.timer);
    this.timer = null;

    switch (action) {
      case 'fold':
        p.folded = true;
        p.lastAction = '弃牌';
        break;

      case 'check':
        if (p.roundBet < this.currentBet) return { error: '需要跟注' };
        p.lastAction = '过牌';
        break;

      case 'call': {
        const callAmt = Math.min(this.currentBet - p.roundBet, p.chips);
        p.chips -= callAmt;
        p.roundBet += callAmt;
        p.totalBet += callAmt;
        this.pot += callAmt;
        if (p.chips === 0) { p.allIn = true; p.lastAction = '全押'; }
        else p.lastAction = '跟注';
        break;
      }

      case 'raise': {
        const isBet = this.currentBet === 0;
        const raiseTo = Math.max(amount, this.currentBet + this.minRaise);
        const toAdd = Math.min(raiseTo - p.roundBet, p.chips);
        p.chips -= toAdd;
        p.roundBet += toAdd;
        p.totalBet += toAdd;
        this.pot += toAdd;
        this.minRaise = Math.max(this.bigBlind, p.roundBet - this.currentBet);
        this.currentBet = p.roundBet;
        if (p.chips === 0) { p.allIn = true; p.lastAction = '全押'; }
        else p.lastAction = isBet ? '下注' : '加注';
        // Rebuild queue: all active non-all-in except raiser, starting after raiser
        const raiserIdx = this.players.indexOf(p);
        const nextIdx = (raiserIdx + 1) % this.players.length;
        this._buildActionQueue(nextIdx, [raiserIdx]);
        if (this.playersToAct.length === 0) {
          this._broadcastState();
          setTimeout(() => this._nextStreet(), 1200);
        } else {
          this._startTimer();
          this._broadcastState();
        }
        return { ok: true };
      }

      case 'allin': {
        const toAdd = p.chips;
        p.chips = 0;
        p.roundBet += toAdd;
        p.totalBet += toAdd;
        this.pot += toAdd;
        p.allIn = true;
        p.lastAction = '全押';
        if (p.roundBet > this.currentBet) {
          // All-in is a raise: rebuild queue and return early (same as 'raise' case)
          this.minRaise = Math.max(this.bigBlind, p.roundBet - this.currentBet);
          this.currentBet = p.roundBet;
          const myIdx = this.players.indexOf(p);
          const nextIdx = (myIdx + 1) % this.players.length;
          this._buildActionQueue(nextIdx, [myIdx]);
          if (this.playersToAct.length === 0) {
            this._broadcastState();
            setTimeout(() => this._nextStreet(), 1200);
          } else {
            this._startTimer();
            this._broadcastState();
          }
          return { ok: true };
        }
        break;
      }

      default:
        return { error: '未知操作' };
    }

    this._advanceQueue();
    return { ok: true };
  }

  _buildActionQueue(startIdx, excludeIdxs = []) {
    const n = this.players.length;
    this.playersToAct = [];
    for (let i = 0; i < n; i++) {
      const idx = (startIdx + i) % n;
      if (excludeIdxs.includes(idx)) continue;
      const p = this.players[idx];
      // Include disconnected players — the 30s timer will auto-act for them
      if (!p.folded && !p.allIn) {
        this.playersToAct.push(idx);
      }
    }
    this.currentIdx = this.playersToAct.length > 0 ? this.playersToAct[0] : -1;
    if (this.currentIdx === -1) {
      clearTimeout(this.timer);
      this.timerDeadline = null;
    }
  }

  _advanceQueue() {
    this.playersToAct.shift();
    this._checkAdvance();
  }

  _checkAdvance() {
    // Count all non-folded players (including disconnected — they're still in the hand)
    const active = this.players.filter(p => !p.folded);

    // Only one player left – they win
    if (active.length <= 1) {
      this._awardPot(active);
      return;
    }

    // All remaining action players gone
    if (this.playersToAct.length === 0) {
      // Clear current player so action buttons are disabled during the delay
      this.currentIdx = -1;
      clearTimeout(this.timer);
      this.timerDeadline = null;
      // Broadcast once so the last action is visible, then advance to next street
      this._broadcastState();
      setTimeout(() => this._nextStreet(), 1200);
      return;
    }

    this.currentIdx = this.playersToAct[0];
    this._startTimer();
    this._broadcastState();
  }

  _nextStreet() {
    // Reset round bets
    for (const p of this.players) {
      p.roundBet = 0;
      p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    const n = this.players.length;
    const firstActive = (startIdx) => {
      // Post-flop always starts from the player left of the dealer:
      // 3+ players: SB (dealerIdx+1); heads-up: BB (non-dealer) acts first post-flop.
      const offset = 1;
      for (let i = offset; i < n + offset; i++) {
        const p = this.players[(startIdx + i) % n];
        // Include disconnected players in action order (timer handles them)
        if (!p.folded) return (startIdx + i) % n;
      }
      return -1;
    };

    switch (this.phase) {
      case PHASE.PREFLOP:
        this.communityCards.push(...this.deck.deal(3));
        this.phase = PHASE.FLOP;
        break;
      case PHASE.FLOP:
        this.communityCards.push(...this.deck.deal(1));
        this.phase = PHASE.TURN;
        break;
      case PHASE.TURN:
        this.communityCards.push(...this.deck.deal(1));
        this.phase = PHASE.RIVER;
        break;
      case PHASE.RIVER:
        this._showdown();
        return;
    }

    const startIdx = firstActive(this.dealerIdx);
    this._buildActionQueue(startIdx);

    // If no meaningful betting can occur, run out remaining streets automatically.
    // Cases: (a) everyone is all-in → playersToAct empty,
    //        (b) one player has chips but all others are all-in → they have no one to bet against
    const hasAllIn = this.players.some(p => !p.folded && p.allIn);
    if (this.playersToAct.length === 0 || (this.playersToAct.length === 1 && hasAllIn)) {
      // Clear current player so no action buttons are shown during the auto-run delay
      this.playersToAct = [];
      this.currentIdx = -1;
      this.timerDeadline = null;
      clearTimeout(this.timer);
      this._broadcastState();
      setTimeout(() => this._nextStreet(), 1200);
      return;
    }

    this._startTimer();
    this._broadcastState();
  }

  _showdown() {
    this.phase = PHASE.SHOWDOWN;
    clearTimeout(this.timer);

    const active = this.players.filter(p => !p.folded);
    const pots = this._calculatePots();
    const results = [];

    for (const pot of pots) {
      const eligible = pot.eligible.filter(p => !p.folded);
      if (eligible.length === 0) continue;

      // Evaluate hands
      const evaluated = eligible.map(p => ({
        player: p,
        hand: bestHand([...p.holeCards, ...this.communityCards]),
      }));

      evaluated.sort((a, b) => compareEvals(b.hand.eval, a.hand.eval));
      const bestEval = evaluated[0].hand.eval;
      const winners = evaluated.filter(e => compareEvals(e.hand.eval, bestEval) === 0);

      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;

      for (const w of winners) {
        w.player.chips += share;
      }
      // Remainder goes to first winner (closest to dealer left)
      if (remainder > 0) winners[0].player.chips += remainder;

      results.push({
        potAmount: pot.amount,
        winners: winners.map(w => ({ id: w.player.id, name: w.player.name, handName: w.hand.name })),
      });
    }

    // Record hand history
    const histWinMap = {};
    for (const r of results) {
      const share = Math.floor(r.potAmount / r.winners.length);
      for (const w of r.winners) {
        if (!histWinMap[w.id]) {
          const p = this.players.find(p => p.id === w.id);
          histWinMap[w.id] = { name: w.name, holeCards: p ? [...p.holeCards] : [], handName: w.handName, potWon: 0, totalBet: p ? p.totalBet : 0 };
        }
        histWinMap[w.id].potWon += share;
      }
    }
    this.handHistory.unshift({
      handNum: ++this.handNum,
      communityCards: [...this.communityCards],
      wonByFold: false,
      winners: Object.values(histWinMap).map(w => ({
        name: w.name, holeCards: w.holeCards, handName: w.handName,
        netProfit: w.potWon - w.totalBet,
      })),
    });

    this.revealAll = true;
    this.lastResult = results;
    this.nextHandAt = Date.now() + 10000;
    this._broadcastState();

    // Advance dealer seat and start next hand after 10 seconds
    this._advanceDealerSeat();
    this._scheduleNextHand(10000);
  }

  _calculatePots() {
    // Build list of (player, totalBet) entries including folded
    const allBets = this.players.map(p => ({ player: p, remaining: p.totalBet }));
    const pots = [];

    while (allBets.some(b => b.remaining > 0)) {
      const minBet = Math.min(...allBets.filter(b => b.remaining > 0).map(b => b.remaining));
      let potAmount = 0;
      const eligible = [];

      for (const b of allBets) {
        const contrib = Math.min(b.remaining, minBet);
        potAmount += contrib;
        b.remaining -= contrib;
        if (contrib > 0 && !b.player.folded) eligible.push(b.player);
      }

      if (potAmount > 0) pots.push({ amount: potAmount, eligible });
    }

    return pots;
  }

  _awardPot(winners) {
    this.phase = PHASE.SHOWDOWN;
    this.revealAll = false; // won by fold — cards hidden until winner chooses to show
    clearTimeout(this.timer);

    if (winners.length === 1) {
      winners[0].chips += this.pot;
      this.lastResult = [{
        potAmount: this.pot,
        winners: [{ id: winners[0].id, name: winners[0].name, handName: '' }],
      }];
      // Give the winner a 3-second window to voluntarily show their cards
      this.showCardsWinnerId = winners[0].id;
      // Record history (this.pot still holds original value before zeroing)
      this.handHistory.unshift({
        handNum: ++this.handNum,
        communityCards: [...this.communityCards],
        wonByFold: true,
        winners: [{
          name: winners[0].name,
          holeCards: [],
          handName: '',
          netProfit: this.pot - winners[0].totalBet,
        }],
      });
    }
    this.pot = 0;
    this.nextHandAt = Date.now() + 6000;
    this._broadcastState();

    this._advanceDealerSeat();
    this.showCardsTimer = setTimeout(() => {
      this.showCardsWinnerId = null;
      this._broadcastState(); // remove the "Show Cards" button
      this._scheduleNextHand(500);
    }, 5500);
  }

  // Remove a disconnected standing player from the room (but keep in final leaderboard)
  kickPlayer(playerId) {
    const si = this.standingPlayers.findIndex(p => p.id === playerId);
    if (si >= 0) {
      const p = this.standingPlayers[si];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.standingPlayers.splice(si, 1);
      this.kickedPlayers.push(p);
      this._broadcastState();
      return;
    }
    // Safety: also handle if still in pending/active pools
    const pi = this.pendingPlayers.findIndex(p => p.id === playerId);
    if (pi >= 0) {
      const p = this.pendingPlayers[pi];
      if (p.seatIndex !== null) { this.seats[p.seatIndex] = null; }
      this.pendingPlayers.splice(pi, 1);
      this.kickedPlayers.push(p);
      this._broadcastState();
    }
  }

  configure(hostId, config) {
    if (hostId !== this.hostId) return { error: '只有房主才能设置' };

    if (this.phase === PHASE.WAITING) {
      // Waiting room: all settings apply immediately
      if (config.startingChips !== undefined) {
        const v = parseInt(config.startingChips);
        if (!isNaN(v) && v >= 100) {
          this.startingChips = v;
          for (const p of [...this.players, ...this.pendingPlayers, ...this.standingPlayers]) {
            p.chips = v;
          }
          if (this.maxBuyIn < v) this.maxBuyIn = v;
        }
      }
      if (config.bigBlind !== undefined) {
        const v = parseInt(config.bigBlind);
        if (!isNaN(v) && v >= 2) {
          this.bigBlind = v;
          this.smallBlind = Math.max(1, Math.floor(v / 2));
          this.minRaise = v;
        }
      }
      if (config.maxBuyIn !== undefined) {
        const v = parseInt(config.maxBuyIn);
        if (!isNaN(v) && v >= 100) this.maxBuyIn = v;
      }
    } else {
      // Mid-game: blind and buy-in changes take effect next hand
      if (config.bigBlind !== undefined) {
        const v = parseInt(config.bigBlind);
        if (!isNaN(v) && v >= 2) this.pendingBigBlind = v;
      }
      if (config.maxBuyIn !== undefined) {
        const v = parseInt(config.maxBuyIn);
        if (!isNaN(v) && v >= 100) this.pendingMaxBuyIn = v;
      }
    }
    return { ok: true };
  }

  buyIn(playerId, amount) {
    if (this.pendingEnd) return { error: '游戏即将结束，无法买入' };
    if (this.phase === PHASE.WAITING) return { error: '游戏尚未开始' };

    const buyAmount = Math.max(100, Math.min(Math.round(parseInt(amount) || 1000), this.maxBuyIn));

    // Broke spectator buying back in
    const brokeIdx = this.brokeSpectators.findIndex(p => p.id === playerId);
    if (brokeIdx >= 0) {
      const p = this.brokeSpectators[brokeIdx];
      p.chips += buyAmount;
      p.totalLoaned += buyAmount;
      this.brokeSpectators.splice(brokeIdx, 1);
      // If they have a seat (reserved before going broke), move to pendingPlayers
      // Otherwise they go to standingPlayers to choose a seat
      if (p.seatIndex !== null && this.seats[p.seatIndex] === playerId) {
        this.pendingPlayers.push(p);
      } else {
        p.seatIndex = null;
        this.standingPlayers.push(p);
      }
      this._broadcastState();
      // If game was waiting for players, start once we have enough
      if (this.waitingForBuyIn) {
        const seated = this.players.filter(p => p.seatIndex !== null).length
          + this.pendingPlayers.filter(p => p.seatIndex !== null).length;
        if (seated >= 2) {
          this.waitingForBuyIn = false;
          this._scheduleNextHand(2000);
        }
      }
      return { ok: true };
    }

    // Active player still in this.players with 0 chips (during showdown window)
    const p = this._player(playerId);
    if (p && p.chips === 0) {
      p.chips += buyAmount;
      p.totalLoaned += buyAmount;
      this._broadcastState();
      return { ok: true };
    }

    return { error: '当前无法买入' };
  }

  requestEndGame(hostId) {
    if (hostId !== this.hostId) return { error: '只有房主才能结束游戏' };
    if (this.phase === PHASE.WAITING) return { error: '游戏尚未开始' };
    // If waiting for players (only 1 seated), end immediately
    if (this.waitingForBuyIn) {
      clearTimeout(this._nextHandTimer);
      this._nextHandTimer = null;
      this._handStarting = false;
      this._finalLeaderboard();
      return { ok: true };
    }
    this.pendingEnd = true;
    this._broadcastState();
    return { ok: true };
  }

  _finalLeaderboard() {
    this.phase = 'ended';
    this.timerDeadline = null;
    clearTimeout(this.timer);
    const seen = new Set();
    const allPlayers = [...this.players, ...this.brokeSpectators, ...this.pendingPlayers, ...this.standingPlayers, ...this.kickedPlayers, ...this.leftPlayers]
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    this.finalRankings = allPlayers
      .map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        totalLoaned: p.totalLoaned,
        invested: this.startingChips + p.totalLoaned,
        netProfit: p.chips - this.startingChips - p.totalLoaned,
      }))
      .sort((a, b) => b.netProfit - a.netProfit);
    this._broadcastState();
  }

  handleShowCards(playerId) {
    if (this.showCardsWinnerId !== playerId) return { error: '只有赢家可以在此阶段show牌' };
    clearTimeout(this.showCardsTimer);
    this.showCardsWinnerId = null;

    const winner = this._player(playerId);
    if (winner) {
      winner.showedCards = true;
      // Update the most recent history entry with the revealed hole cards
      if (this.handHistory.length > 0 && this.handHistory[0].wonByFold) {
        this.handHistory[0].winners[0].holeCards = [...winner.holeCards];
      }
    }

    this.nextHandAt = Date.now() + 6000;
    this._broadcastState();

    // Stay for 6 more seconds so everyone can see the cards
    this._advanceDealerSeat();
    this._scheduleNextHand(6000);

    return { ok: true };
  }

  // ── Timer ──────────────────────────────────────────────────────────────────

  _startTimer() {
    clearTimeout(this.timer);
    this.timerDeadline = Date.now() + TURN_TIME * 1000;
    this.timer = setTimeout(() => {
      const p = this.players[this.currentIdx];
      if (!p) return;
      const wasDisconnected = !!p.disconnected;
      // Auto-action: check if possible, else fold
      if (p.roundBet >= this.currentBet) {
        this.handleAction(p.id, 'check', 0);
      } else {
        this.handleAction(p.id, 'fold', 0);
        // If auto-folded while disconnected, schedule this player to stand up at next hand start
        if (wasDisconnected) {
          const pp = this._player(p.id);
          if (pp) pp.pendingStandUpDisconnected = true;
        }
      }
    }, TURN_TIME * 1000);
  }

  // ── State broadcasting ─────────────────────────────────────────────────────

  _broadcastState() {
    for (const p of this.players) {
      if (p.permanentlyLeft) continue; // player already left, don't send them state
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('game_state', this._stateFor(p.id));
    }
    // Send spectator view to pending players, standing players, and broke spectators
    for (const p of [...this.pendingPlayers, ...this.standingPlayers, ...this.brokeSpectators]) {
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) sock.emit('game_state', this._stateFor(p.id));
    }
    this.io.to(this.roomCode).emit('room_update', this._publicRoomInfo());
  }

  _stateFor(playerId) {
    const isShowdown = this.phase === PHASE.SHOWDOWN;
    const myPlayer = this._player(playerId);
    const isBrokeSpectator = !myPlayer && this.brokeSpectators.some(p => p.id === playerId);
    const myStandingPlayer = !myPlayer && this.standingPlayers.find(p => p.id === playerId);
    const myPendingPlayer = !myPlayer && !myStandingPlayer && this.pendingPlayers.find(p => p.id === playerId);

    const n = this.players.length;
    const sbIdx = n === 2 ? this.dealerIdx : (this.dealerIdx + 1) % n;
    const bbIdx = (this.dealerIdx + 1 + (n === 2 ? 0 : 1)) % n;

    const players = [
      ...this.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        totalLoaned: p.totalLoaned || 0,
        roundBet: p.roundBet,
        totalBet: p.totalBet,
        folded: p.folded,
        allIn: p.allIn,
        lastAction: p.lastAction,
        isDealer: idx === this.dealerIdx && n > 2,
        isSB: idx === sbIdx,
        isBB: idx === bbIdx,
        isCurrent: idx === this.currentIdx,
        disconnected: !!p.disconnected,
        seatIndex: p.seatIndex,
        // Reveal cards if: own cards, real showdown (went to river), or voluntarily shown
        ...(() => {
          const reveal = p.id === playerId || this.revealAll || !!p.showedCards;
          const holeCards = reveal ? p.holeCards : p.holeCards.map(() => null);
          // Show hand name: for own cards from flop onwards; for others only at real showdown
          const showHandName = !p.folded && p.holeCards.length > 0 && (
            (p.id === playerId && this.communityCards.length >= 3) ||
            (isShowdown && this.revealAll)
          );
          if (reveal && showHandName) {
            const h = bestHand([...p.holeCards, ...this.communityCards]);
            return { holeCards, handName: h.name, bestCards: h.cards };
          }
          return { holeCards, handName: null, bestCards: null };
        })(),
      })),
      // Pending players (joined mid-hand) appear as folded so they're visible on the table
      ...this.pendingPlayers
        .filter(p => p.seatIndex !== null)
        .map(p => ({
          id: p.id,
          name: p.name,
          chips: p.chips,
          totalLoaned: p.totalLoaned || 0,
          roundBet: 0,
          totalBet: 0,
          folded: true,
          allIn: false,
          lastAction: null,
          isDealer: false,
          isSB: false,
          isBB: false,
          isCurrent: false,
          disconnected: false,
          seatIndex: p.seatIndex,
          holeCards: [],
          handName: null,
          bestCards: null,
        })),
    ];

    // Available actions for the current player
    let actions = null;
    if (myPlayer && !myPlayer.folded && this.players[this.currentIdx]?.id === playerId && this.phase !== PHASE.SHOWDOWN) {
      const canCheck = myPlayer.roundBet >= this.currentBet;
      const callAmt = Math.min(this.currentBet - myPlayer.roundBet, myPlayer.chips);
      const canCall = !canCheck && callAmt > 0;
      const canRaise = myPlayer.chips > callAmt;
      actions = {
        canFold: true,
        canCheck,
        canCall,
        callAmount: callAmt,
        canRaise,
        isBet: this.currentBet === 0,
        minRaise: this.currentBet + this.minRaise,
        maxRaise: myPlayer.chips + myPlayer.roundBet,
      };
    }

    const myBrokeSpectator = this.brokeSpectators.find(p => p.id === playerId);
    const myTotalLoaned = myPlayer?.totalLoaned || myBrokeSpectator?.totalLoaned || 0;

    // Build seat map: each seat slot info
    const allPlayersByPid = {};
    for (const p of [...this.players, ...this.pendingPlayers, ...this.standingPlayers, ...this.brokeSpectators]) {
      allPlayersByPid[p.id] = p;
    }
    const seatsInfo = this.seats.map((pid, i) => {
      if (!pid) return { seatIndex: i, playerId: null, name: null, chips: null, isActive: false };
      const sp = allPlayersByPid[pid];
      return {
        seatIndex: i,
        playerId: pid,
        name: sp?.name ?? null,
        chips: sp?.chips ?? null,
        isActive: this.players.some(p => p.id === pid),
      };
    });

    const mySeatIndex = myPlayer?.seatIndex ?? myStandingPlayer?.seatIndex ?? myPendingPlayer?.seatIndex ?? myBrokeSpectator?.seatIndex ?? null;
    const canStandUp = (!!myPlayer && myPlayer.folded && this.phase !== PHASE.SHOWDOWN && this.phase !== PHASE.WAITING)
      || (!!myPlayer && this.phase === PHASE.WAITING)
      || (!!myPendingPlayer && myPendingPlayer.seatIndex !== null);

    return {
      phase: this.phase,
      communityCards: this.communityCards,
      pot: this.pot,
      currentBet: this.currentBet,
      players,
      myId: playerId,
      timerDeadline: this.timerDeadline,
      actions,
      lastResult: this.lastResult,
      roomCode: this.roomCode,
      isSpectator: !myPlayer,
      isBrokeSpectator,
      myTotalLoaned,
      canShowCards: this.showCardsWinnerId === playerId,
      revealAll: this.revealAll,
      maxBuyIn: this.maxBuyIn,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      pendingBigBlind: this.pendingBigBlind || null,
      pendingMaxBuyIn: this.pendingMaxBuyIn || null,
      pendingEnd: this.pendingEnd,
      finalRankings: this.finalRankings,
      waitingForBuyIn: this.waitingForBuyIn,
      // Broke spectators can buy in any time; active 0-chip players only during showdown
      canBuyIn: !this.pendingEnd && (
        isBrokeSpectator ||
        (!!myPlayer && myPlayer.chips === 0 && isShowdown)
      ),
      isHost: playerId === this.hostId,
      nextHandAt: this.nextHandAt,
      handHistory: this.handHistory,
      seats: seatsInfo,
      mySeatIndex,
      canStandUp,
      isStanding: !!myStandingPlayer || (!!myPlayer && !!myPlayer.pendingStandUp),
    };
  }

  _publicRoomInfo() {
    return {
      roomCode: this.roomCode,
      displayCode: this.displayCode,
      isPrivate: this.isPrivate,
      hostId: this.hostId,
      phase: this.phase,
      startingChips: this.startingChips,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      maxBuyIn: this.maxBuyIn,
      playerCount: this.players.length + this.pendingPlayers.length + this.standingPlayers.length,
      players: this.players.map(p => ({ id: p.id, name: p.name, chips: p.chips, seatIndex: p.seatIndex })),
      pendingCount: this.pendingPlayers.length,
      pendingPlayers: this.pendingPlayers.map(p => ({ id: p.id, name: p.name, seatIndex: p.seatIndex })),
      standingPlayers: this.standingPlayers.map(p => ({ id: p.id, name: p.name, chips: p.chips })),
      seats: this.seats.map((pid, i) => {
        if (!pid) return { seatIndex: i, playerId: null, name: null };
        const allP = [...this.players, ...this.pendingPlayers, ...this.standingPlayers, ...this.brokeSpectators];
        const sp = allP.find(p => p.id === pid);
        return { seatIndex: i, playerId: pid, name: sp?.name ?? null };
      }),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _player(id) {
    return this.players.find(p => p.id === id) || null;
  }
}

module.exports = PokerGame;
