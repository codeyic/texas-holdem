/** 扑克牌与牌堆 */

export type Suit = "s" | "h" | "d" | "c";

export interface Card {
  r: number;
  s: Suit;
}

const RANK_CHARS = "23456789TJQKA";

export function makeDeck(): Card[] {
  const suits: Suit[] = ["s", "h", "d", "c"];
  const deck: Card[] = [];
  for (const s of suits) {
    for (let r = 2; r <= 14; r += 1) {
      deck.push({ r, s });
    }
  }
  return deck;
}

export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

export function parseCard(code: string): Card {
  const rankChar = code[0];
  const suitChar = code[1] as Suit;
  const r = RANK_CHARS.indexOf(rankChar) + 2;
  return { r, s: suitChar };
}

export function parseCards(codes: string[]): Card[] {
  return codes.map(parseCard);
}

export function cardKey(c: Card): string {
  return `${RANK_CHARS[c.r - 2]}${c.s}`;
}
