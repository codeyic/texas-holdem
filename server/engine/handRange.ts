/** 起手牌范围：基于 Chen 公式对 169 类起手牌排序，按 topPct 截取 */

import type { Card } from "../game/cards";
import { makeDeck } from "../game/cards";

/** "random" 表示任意两张牌；{ topPct } 表示前 topPct（0..1）强的起手牌 */
export type RangeLike = "random" | { topPct: number };

const RANK_CHARS = "23456789TJQKA";

function rankVal(ch: string): number {
  return RANK_CHARS.indexOf(ch) + 2;
}

function rankChar(r: number): string {
  return RANK_CHARS[r - 2];
}

/** 起手牌归类键：AA / AKs / AKo */
export function holeKey(cards: Card[]): string {
  const hi = Math.max(cards[0].r, cards[1].r);
  const lo = Math.min(cards[0].r, cards[1].r);
  const hiC = rankChar(hi);
  const loC = rankChar(lo);
  if (hi === lo) {
    return hiC + loC;
  }
  const suited = cards[0].s === cards[1].s;
  return `${hiC}${loC}${suited ? "s" : "o"}`;
}

const CHEN_HIGH: Record<number, number> = {
  2: 1, 3: 1.5, 4: 2, 5: 2.5, 6: 3, 7: 3.5, 8: 4, 9: 4.5,
  10: 5, 11: 6, 12: 7, 13: 8, 14: 10,
};

/** Chen 公式评分（越高越强） */
export function chenScore(cards: Card[]): number {
  const hi = Math.max(cards[0].r, cards[1].r);
  const lo = Math.min(cards[0].r, cards[1].r);
  let score = CHEN_HIGH[hi] ?? 0;
  if (hi === lo) {
    return Math.max(5, score * 2);
  }
  if (cards[0].s === cards[1].s) {
    score += 2;
  }
  const gap = hi - lo - 1;
  if (gap === 0) {
    score += 1;
  } else if (gap === 2) {
    score -= 1;
  } else if (gap === 3) {
    score -= 2;
  } else if (gap >= 4) {
    score -= 5;
  }
  // 中间牌加成：连张或间隔1且最大牌 ≤ Q 时，5~9 区间的中间牌每张 +1
  if (gap <= 1 && hi < 13) {
    for (let r = lo + 1; r < hi; r += 1) {
      if (r >= 5 && r <= 9) {
        score += 1;
      }
    }
  }
  return score;
}

/** 169 类起手牌按 Chen 分值降序 */
const RANK_ORDER: string[] = (() => {
  const combos: { key: string; score: number }[] = [];
  for (let hi = 2; hi <= 14; hi += 1) {
    for (let lo = 2; lo <= hi; lo += 1) {
      if (hi === lo) {
        combos.push({
          key: rankChar(hi) + rankChar(hi),
          score: chenScore([{ r: hi, s: "h" }, { r: hi, s: "d" }]),
        });
      } else {
        combos.push({
          key: `${rankChar(hi)}${rankChar(lo)}s`,
          score: chenScore([{ r: hi, s: "h" }, { r: lo, s: "h" }]),
        });
        combos.push({
          key: `${rankChar(hi)}${rankChar(lo)}o`,
          score: chenScore([{ r: hi, s: "h" }, { r: lo, s: "d" }]),
        });
      }
    }
  }
  combos.sort((a, b) => b.score - a.score);
  return combos.map((c) => c.key);
})();

function rangeKeys(range: RangeLike): string[] {
  if (range === "random") {
    return RANK_ORDER;
  }
  const n = Math.max(1, Math.round(range.topPct * RANK_ORDER.length));
  return RANK_ORDER.slice(0, n);
}

/** 从可用牌堆中构造指定起手牌键的一手牌；无法构造时返回 null */
function holeFromKey(key: string, deck: Card[]): Card[] | null {
  if (key.length === 2) {
    const r = rankVal(key[0]);
    const cs = deck.filter((c) => c.r === r);
    if (cs.length < 2) {
      return null;
    }
    return [cs[0], cs[1]];
  }
  const hi = rankVal(key[0]);
  const lo = rankVal(key[1]);
  const suited = key.endsWith("s");
  const hs = deck.filter((c) => c.r === hi);
  const ls = deck.filter((c) => c.r === lo);
  const a = hs[0];
  if (!a) {
    return null;
  }
  const cands = suited ? ls.filter((c) => c.s === a.s) : ls.filter((c) => c.s !== a.s);
  const b = cands[0];
  if (!b) {
    return null;
  }
  return [a, b];
}

/** 从范围中随机抽一手牌，排除 dead（自己手牌/公共牌/其他对手） */
export function randomHoleFromRange(
  range: RangeLike,
  dead: Card[],
  rng: () => number = Math.random,
): Card[] | null {
  const deck = makeDeck().filter(
    (c) => !dead.some((d) => d.r === c.r && d.s === c.s),
  );
  const keys = rangeKeys(range);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const key = keys[Math.floor(rng() * keys.length)];
    const hole = holeFromKey(key, deck);
    if (hole) {
      return hole;
    }
  }
  return null;
}

/** 一手牌是否属于该范围 */
export function holeInRange(range: RangeLike, hole: Card[]): boolean {
  const key = holeKey(hole);
  if (range === "random") {
    return true;
  }
  return rangeKeys(range).includes(key);
}
