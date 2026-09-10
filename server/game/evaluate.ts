/** 五张/七张牌力评估，数值越大越强 */

import type { Card } from "./cards";

export const HAND_NAMES = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺",
];

export function compareValue(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
}

function straightHigh(uniqueDesc: number[]): number {
  if (uniqueDesc.length < 5) {
    return 0;
  }
  const set = new Set(uniqueDesc);
  const seq = [...uniqueDesc];
  if (set.has(14)) {
    seq.push(1);
  }
  for (const high of uniqueDesc) {
    if (
      set.has(high) &&
      set.has(high - 1) &&
      set.has(high - 2) &&
      set.has(high - 3) &&
      (set.has(high - 4) || (high === 5 && set.has(14)))
    ) {
      if (high === 5 && set.has(14) && !set.has(1)) {
        return 5;
      }
      return high;
    }
  }
  const wheel =
    set.has(14) && set.has(5) && set.has(4) && set.has(3) && set.has(2);
  if (wheel) {
    return 5;
  }
  return 0;
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

/** 返回 [牌型档位, ...踢脚]，可直接比较 */
export function evaluate5(cards: Card[]): number[] {
  if (cards.length !== 5) {
    throw new Error("evaluate5 需要五张牌");
  }
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const counts = new Map<number, number>();
  for (const r of ranks) {
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return b[0] - a[0];
  });
  const uniqueDesc = [...new Set(ranks)];
  const sHigh = straightHigh(uniqueDesc);

  if (flush && sHigh) {
    return [8, sHigh];
  }
  if (groups[0][1] === 4) {
    return [7, groups[0][0], groups[1][0]];
  }
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) {
    return [6, groups[0][0], groups[1][0]];
  }
  if (flush) {
    return [5, ...ranks];
  }
  if (sHigh) {
    return [4, sHigh];
  }
  if (groups[0][1] === 3) {
    const kickers = groups.filter((g) => g[1] === 1).map((g) => g[0]);
    return [3, groups[0][0], ...kickers];
  }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const kicker = groups.find((g) => g[1] === 1)?.[0] ?? 0;
    return [2, groups[0][0], groups[1][0], kicker];
  }
  if (groups[0][1] === 2) {
    const kickers = groups.filter((g) => g[1] === 1).map((g) => g[0]);
    return [1, groups[0][0], ...kickers];
  }
  return [0, ...ranks];
}

export function bestHand(cards: Card[]): number[] {
  if (cards.length < 5) {
    throw new Error("至少五张牌才能比牌");
  }
  if (cards.length === 5) {
    return evaluate5(cards);
  }
  let best = [-1];
  for (const five of combos(cards, 5)) {
    const v = evaluate5(five);
    if (compareValue(v, best) > 0) {
      best = v;
    }
  }
  return best;
}

export function handName(value: number[]): string {
  const cat = value[0] ?? 0;
  return HAND_NAMES[cat] ?? "未知";
}
