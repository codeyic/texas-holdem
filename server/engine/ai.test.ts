import { describe, expect, it } from "vitest";
import { parseCards } from "../game/cards";
import { chooseAiAction, AI_PROFILES } from "./ai";

const profile = AI_PROFILES.tightAggressive;

describe("AI 决策引擎", () => {
  it("河牌成葫芦（强牌）：倾向加注/下注", () => {
    const choice = chooseAiAction({
      hole: parseCards(["Ah", "Ad"]),
      community: parseCards(["Ac", "Kh", "Kd", "2s", "3h"]),
      profile,
      pot: 300,
      toCall: 0,
      minRaiseTo: 100,
      maxRaiseTo: 500,
      chips: 800,
      canCheck: true,
      opponents: 2,
      rng: () => 0.1,
    });
    expect(["raise", "allin"]).toContain(choice.action);
  });

  it("弱牌面对大注：弃牌", () => {
    const choice = chooseAiAction({
      hole: parseCards(["2h", "7d"]),
      community: parseCards(["Ac", "Kd", "9s"]),
      profile,
      pot: 100,
      toCall: 200,
      minRaiseTo: 400,
      maxRaiseTo: 900,
      chips: 900,
      canCheck: false,
      opponents: 2,
      rng: () => 0.1,
    });
    expect(choice.action).toBe("fold");
  });

  it("中等牌可以过牌时：过牌而非盲目下注", () => {
    const choice = chooseAiAction({
      hole: parseCards(["Ah", "5d"]),
      community: parseCards(["2c", "7d", "9s"]),
      profile: AI_PROFILES.tightPassive,
      pot: 100,
      toCall: 0,
      minRaiseTo: 50,
      maxRaiseTo: 200,
      chips: 300,
      canCheck: true,
      opponents: 2,
      rng: () => 0.5,
    });
    expect(["check", "call"]).toContain(choice.action);
  });

  it("加注金额落在合法区间", () => {
    const choice = chooseAiAction({
      hole: parseCards(["Kh", "Kd"]),
      community: parseCards(["Kc", "2h", "7d", "9s"]),
      profile,
      pot: 200,
      toCall: 0,
      minRaiseTo: 60,
      maxRaiseTo: 400,
      chips: 400,
      canCheck: true,
      opponents: 2,
    });
    if (choice.action === "raise" || choice.action === "allin") {
      const to = choice.raiseTo ?? 400;
      expect(to).toBeGreaterThanOrEqual(60);
      expect(to).toBeLessThanOrEqual(400);
    }
  });
});
