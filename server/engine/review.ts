/** 复盘：推荐动作、EV 差距、漏洞标签 */

import type { ClientAction } from "../../shared/protocol";

export interface Recommendation {
  action: ClientAction;
  raiseTo?: number;
  evGap: number; // 推荐动作相对弃牌/现状的 EV 提升
  leakTags: string[];
}

/** 估算一个动作的相对 EV（相对 fold=0） */
export function actionEv(
  action: ClientAction,
  winEquity: number,
  pot: number,
  toCall: number,
): number {
  if (action === "fold") {
    return 0;
  }
  if (action === "check") {
    return winEquity * pot;
  }
  if (action === "call") {
    return winEquity * (pot + toCall) - (1 - winEquity) * toCall;
  }
  // raise：近似用 call 的 EV 加上底池挤压增益
  const callEv = winEquity * (pot + toCall) - (1 - winEquity) * toCall;
  return callEv + winEquity * pot * 0.3;
}

export function recommendAction(opts: {
  winEquity: number;
  pot: number;
  toCall: number;
  canCheck: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  chips: number;
}): Recommendation {
  const { winEquity: win, pot, toCall, canCheck, minRaiseTo, maxRaiseTo } = opts;
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;
  const leakTags: string[] = [];

  let best = "fold" as ClientAction;
  let bestEv = -Infinity;
  const consider = (action: ClientAction) => {
    const ev = actionEv(action, win, pot, toCall);
    if (ev > bestEv) {
      bestEv = ev;
      best = action;
    }
  };

  if (canCheck) {
    consider("check");
  } else if (toCall > 0) {
    consider("call");
  }
  consider("fold");
  // 仅强牌（价值加注）才推荐加注，避免弱牌被推荐诈唬加注
  if (maxRaiseTo > toCall && maxRaiseTo > 0 && win >= 0.5) {
    consider("raise");
  }

  // 追大注跟注过多：本决策点跟注为负 EV 时打标（与推荐动作是否跟注无关）
  if (best !== "call" && win < potOdds && toCall > pot * 0.3) {
    leakTags.push("calling_too_much");
  }
  if (best === "raise" && win >= 0.7) {
    leakTags.push("checking_strong");
  }
  if (best === "check" && win >= 0.8) {
    leakTags.push("checking_strong");
  }

  const raiseTo =
    best === "raise" ? Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(pot * 0.7))) : undefined;
  const foldEv = actionEv("fold", win, pot, toCall);
  return { action: best, raiseTo, evGap: bestEv - foldEv, leakTags };
}

export function classifyLeaks(opts: {
  actualAction: ClientAction;
  recommendedAction: ClientAction;
  winEquity: number;
  pot: number;
  toCall: number;
}): string[] {
  const { actualAction, recommendedAction, winEquity, pot, toCall } = opts;
  const tags: string[] = [];
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;

  if (actualAction === "fold" && winEquity >= 0.7) {
    tags.push("folding_strong");
  }
  if (actualAction === "call" && winEquity < potOdds && toCall > pot * 0.3) {
    tags.push("calling_too_much");
  }
  if (actualAction === "check" && winEquity >= 0.8) {
    tags.push("checking_strong");
  }
  if (
    (actualAction === "raise" || actualAction === "allin") &&
    winEquity < 0.35 &&
    recommendedAction !== "raise"
  ) {
    tags.push("bluffing_too_often");
  }
  if (actualAction === "call" && winEquity >= 0.7 && recommendedAction === "raise") {
    tags.push("preflop_missed_raise");
  }
  return tags;
}
