/** 手牌中文读法，供语音提示 */

import type { CardDto } from "./protocol";

const SUIT_NAME: Record<CardDto["s"], string> = {
  s: "黑桃",
  h: "红桃",
  d: "方块",
  c: "梅花",
};

export function rankSpeech(r: number): string {
  if (r === 14) {
    return "A";
  }
  if (r === 13) {
    return "K";
  }
  if (r === 12) {
    return "Q";
  }
  if (r === 11) {
    return "J";
  }
  if (r === 10) {
    return "十";
  }
  return String(r);
}

export function cardSpeech(card: CardDto): string {
  return `${SUIT_NAME[card.s]}${rankSpeech(card.r)}`;
}

export function holeCardsSpeech(cards: CardDto[]): string {
  if (cards.length < 2) {
    return "";
  }
  return `你的手牌是${cardSpeech(cards[0])}和${cardSpeech(cards[1])}`;
}
