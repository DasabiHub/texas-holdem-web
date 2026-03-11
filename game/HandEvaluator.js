'use strict';

const HAND_NAMES = ['high_card','one_pair','two_pair','three_of_a_kind','straight','flush','full_house','four_of_a_kind','straight_flush','royal_flush'];

function evaluateFive(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const freq = {};
  for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
  const counts = Object.values(freq).sort((a, b) => b - a);

  // Detect straight
  let straightHigh = 0;
  const uniq = [...new Set(ranks)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) {
      straightHigh = uniq[0];
    } else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
      straightHigh = 5; // Wheel
    }
  }

  if (isFlush && straightHigh) {
    if (straightHigh === 14) return [9, 14]; // Royal Flush
    return [8, straightHigh];
  }
  if (counts[0] === 4) {
    const four = +Object.keys(freq).find(r => freq[r] === 4);
    const kicker = +Object.keys(freq).find(r => freq[r] !== 4);
    return [7, four, kicker];
  }
  if (counts[0] === 3 && counts[1] === 2) {
    const three = +Object.keys(freq).find(r => freq[r] === 3);
    const pair = +Object.keys(freq).find(r => freq[r] === 2);
    return [6, three, pair];
  }
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (counts[0] === 3) {
    const three = +Object.keys(freq).find(r => freq[r] === 3);
    const kickers = ranks.filter(r => r !== three);
    return [3, three, ...kickers];
  }
  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = Object.keys(freq).filter(r => freq[r] === 2).map(Number).sort((a, b) => b - a);
    const kicker = ranks.find(r => !pairs.includes(r));
    return [2, ...pairs, kicker];
  }
  if (counts[0] === 2) {
    const pair = +Object.keys(freq).find(r => freq[r] === 2);
    const kickers = ranks.filter(r => r !== pair);
    return [1, pair, ...kickers];
  }
  return [0, ...ranks];
}

function compareEvals(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHand(cards) {
  // cards: 5-7 cards, find best 5-card hand by trying all C(n,5) combinations
  const n = cards.length;
  if (n === 5) {
    const ev = evaluateFive(cards);
    return { eval: ev, name: HAND_NAMES[ev[0]], cards };
  }
  let best = null;
  for (let i = 0; i < n - 4; i++)
    for (let j = i + 1; j < n - 3; j++)
      for (let k = j + 1; k < n - 2; k++)
        for (let l = k + 1; l < n - 1; l++)
          for (let m = l + 1; m < n; m++) {
            const five = [cards[i], cards[j], cards[k], cards[l], cards[m]];
            const ev = evaluateFive(five);
            if (!best || compareEvals(ev, best.eval) > 0)
              best = { eval: ev, name: HAND_NAMES[ev[0]], cards: five };
          }
  return best;
}

module.exports = { bestHand, compareEvals };
