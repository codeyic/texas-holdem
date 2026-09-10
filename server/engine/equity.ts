/** 胜率引擎：蒙特卡洛采样（翻前补全 5 张公共牌，翻后补全剩余公共牌） */

import type { Card } from "../game/cards";
import { makeDeck } from "../game/cards";
import { bestHand, compareValue } from "../game/evaluate";
import { randomHoleFromRange, type RangeLike } from "./handRange";

export interface EquityResult {
  win: number;
  tie: number;
  lose: number; // 三者之和恒为 1
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

/** 在已有公共牌基础上随机补全到 5 张（翻前 community 为空则全抽） */
function completeBoard(
  community: Card[],
  exclude: Card[],
  rng: () => number,
): Card[] {
  const deck = remainingDeck([...community, ...exclude]);
  const board = [...community];
  while (board.length < 5) {
    const idx = Math.floor(rng() * deck.length);
    board.push(deck.splice(idx, 1)[0]);
  }
  return board;
}

export function winEquity(opts: {
  heroCards: Card[];
  community: Card[];
  opponents: RangeLike[];
  iterations?: number; // 采样次数，默认 1000；翻后可用较少（500）
  rng?: () => number;
}): EquityResult {
  const { heroCards, community, opponents } = opts;
  const rng = opts.rng ?? Math.random;
  const iterations = opts.iterations ?? 1000;
  const dead = [...heroCards, ...community];

  let win = 0;
  let tie = 0;
  let done = 0;
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
    const board = completeBoard(community, [...dead, ...oppHoles.flat()], rng);
    const res = heroVsOpponents(heroCards, oppHoles, board);
    if (res === "win") {
      win += 1;
    } else if (res === "tie") {
      tie += 1;
    }
    done += 1;
  }
  if (done === 0) {
    return { win: 0, tie: 0, lose: 1 };
  }
  return { win: win / done, tie: tie / done, lose: (done - win - tie) / done };
}
