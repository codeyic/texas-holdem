/** AI 决策引擎：基于胜率与单街 EV 近似选择动作 */

import type { Card } from "../game/cards";
import { winEquity } from "./equity";

export interface AiProfile {
  name: string;
  tightness: number; // 0..1 越高越紧（更少玩弱牌）
  aggression: number; // 0..1 越高越凶（更多加注）
  bluffFreq: number; // 0..1 诈唬概率
}

export const AI_PROFILES: Record<string, AiProfile> = {
  tightAggressive: { name: "紧凶", tightness: 0.6, aggression: 0.85, bluffFreq: 0.05 },
  looseAggressive: { name: "松凶", tightness: 0.2, aggression: 0.9, bluffFreq: 0.18 },
  tightPassive: { name: "紧弱", tightness: 0.8, aggression: 0.25, bluffFreq: 0.02 },
};

/** 按昵称映射 AI 性格（昵称形如 "AI-紧凶"）；未匹配时用紧凶 */
export function profileByNickname(nickname: string): AiProfile {
  if (nickname.includes("松凶")) {
    return AI_PROFILES.looseAggressive;
  }
  if (nickname.includes("紧弱")) {
    return AI_PROFILES.tightPassive;
  }
  return AI_PROFILES.tightAggressive;
}

export type AiAction = "fold" | "check" | "call" | "raise" | "allin";

export interface AiChoice {
  action: AiAction;
  raiseTo?: number;
}

/** 计算某个下注档位下的目标加注额 */
function raiseSize(
  win: number,
  pot: number,
  minRaiseTo: number,
  maxRaiseTo: number,
  profile: AiProfile,
): number {
  const frac = win >= 0.65 ? 0.75 : win >= 0.45 ? 0.55 : 0.4;
  let target = minRaiseTo + (pot * frac - minRaiseTo) * (0.5 + 0.5 * profile.aggression);
  target = Math.round(target);
  if (target < minRaiseTo) {
    target = minRaiseTo;
  }
  if (target > maxRaiseTo) {
    target = maxRaiseTo;
  }
  return target;
}

export function chooseAiAction(opts: {
  hole: Card[];
  community: Card[];
  profile: AiProfile;
  pot: number;
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  chips: number;
  canCheck: boolean;
  opponents: number;
  rng?: () => number;
}): AiChoice {
  const {
    hole,
    community,
    profile,
    pot,
    toCall,
    minRaiseTo,
    maxRaiseTo,
    chips,
    canCheck,
  } = opts;
  const rng = opts.rng ?? Math.random;
  const opponents = Array.from(
    { length: Math.max(1, opts.opponents) },
    () => "random" as const,
  );
  const iterations = community.length >= 3 ? 120 : 400;
  const eq = winEquity({ heroCards: hole, community, opponents, iterations, rng });
  const win = eq.win;
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;

  // 强牌线：跟随 aggression 决定是否价值加注
  const strong = win >= Math.max(0.55, 1 - profile.tightness * 0.5);

  if (canCheck) {
    if (strong && rng() < profile.aggression) {
      return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
    }
    // 弱牌诈唬
    if (win < 0.5 && rng() < profile.bluffFreq) {
      return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
    }
    return { action: "check" };
  }

  // 需要跟注
  if (strong && rng() < profile.aggression) {
    return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
  }
  const evCall = win * (pot + toCall) - (1 - win) * toCall;
  const cheapCall = toCall <= pot * 0.15 && win > 0.3;
  if (win > potOdds || evCall > 0 || cheapCall) {
    if (toCall >= chips) {
      return { action: "allin" };
    }
    return { action: "call" };
  }
  // 诈唬加注
  if (rng() < profile.bluffFreq && win >= 0.2) {
    return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
  }
  return { action: "fold" };
}
