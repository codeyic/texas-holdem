/** 胜率引擎：翻前蒙特卡洛采样，翻后剩余公共牌精确枚举 */

import type { Card } from "../game/cards";
import { makeDeck } from "../game/cards";
import { bestHand, compareValue } from "../game/evaluate";
import { randomHoleFromRange, type RangeLike } from "./handRange";

export interface EquityResult {
  win: number;
  tie: number;
  lose: number; // 三者之和恒为 1
}

function combos<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const n = items.length;
  const walk = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      acc.push(items[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function remainingDeck(exclude: Card[]): Card[] {
  return makeDeck().filter(
    (c) => !exclude.some((d) => d.r === c.r && d.s === c.s),
  );
}

function heroVsOpponents(
  heroCards: Card[],
  oppHoles: Card[][],
  board: Card[],
): "win" | "tie" | "lose" {
  const hero = bestHand([...heroCards, ...board]);
  let best = [-1];
  for (const h of oppHoles) {
    const v = bestHand([...h, ...board]);
    if (compareValue(v, best) > 0) {
      best = v;
    }
  }
  const cmp = compareValue(hero, best);
  if (cmp > 0) {
    return "win";
  }
  if (cmp === 0) {
    return "tie";
  }
  return "lose";
}

function randomBoard(exclude: Card[], rng: () => number): Card[] {
  const deck = remainingDeck(exclude);
  const board: Card[] = [];
  for (let i = 0; i < 5; i += 1) {
    const idx = Math.floor(rng() * deck.length);
    board.push(deck.splice(idx, 1)[0]);
  }
  return board;
}

export function winEquity(opts: {
  heroCards: Card[];
  community: Card[];
  opponents: RangeLike[];
  iterations?: number; // 翻前采样次数，默认 1000；翻后外层采样次数默认 100
  rng?: () => number;
}): EquityResult {
  const { heroCards, community, opponents } = opts;
  const rng = opts.rng ?? Math.random;
  const dead = [...heroCards, ...community];

  if (community.length >= 3) {
    // 翻后：外层对手范围采样，内层公共牌精确枚举
    const outer = opts.iterations ?? 100;
    const need = 5 - community.length;
    let win = 0;
    let tie = 0;
    let total = 0;
    for (let i = 0; i < outer; i += 1) {
      const oppHoles: Card[][] = [];
      let ok = true;
      for (const range of opponents) {
        const h = randomHoleFromRange(
          range,
          [...dead, ...oppHoles.flat()],
          rng,
        );
        if (!h) {
          ok = false;
          break;
        }
        oppHoles.push(h);
      }
      if (!ok) {
        continue;
      }
      const deck = remainingDeck([...dead, ...oppHoles.flat()]);
      const boards = need === 0 ? [[]] : combos(deck, need);
      for (const extra of boards) {
        const board = [...community, ...extra];
        const res = heroVsOpponents(heroCards, oppHoles, board);
        if (res === "win") {
          win += 1;
        } else if (res === "tie") {
          tie += 1;
        }
        total += 1;
      }
    }
    if (total === 0) {
      return { win: 0, tie: 0, lose: 1 };
    }
    return { win: win / total, tie: tie / total, lose: (total - win - tie) / total };
  }

  // 翻前蒙特卡洛
  const iterations = opts.iterations ?? 1000;
  let win = 0;
  let tie = 0;
  for (let i = 0; i < iterations; i += 1) {
    const oppHoles: Card[][] = [];
    let ok = true;
    for (const range of opponents) {
      const h = randomHoleFromRange(
        range,
        [...dead, ...oppHoles.flat()],
        rng,
      );
      if (!h) {
        ok = false;
        break;
      }
      oppHoles.push(h);
    }
    if (!ok) {
      continue;
    }
    const board = randomBoard([...dead, ...oppHoles.flat()], rng);
    const res = heroVsOpponents(heroCards, oppHoles, board);
    if (res === "win") {
      win += 1;
    } else if (res === "tie") {
      tie += 1;
    }
  }
  return { win: win / iterations, tie: tie / iterations, lose: (iterations - win - tie) / iterations };
}
