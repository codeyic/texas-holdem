import { describe, expect, it } from "vitest";
import { parseCards } from "../game/cards";
import { chooseAiAction, AI_PROFILES, profileByNickname } from "./ai";

const profile = AI_PROFILES.tightAggressive;

/** 确定性伪随机（恒定值会让蒙特卡洛采样退化成同一副牌） */
function seededRng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) {
    s += 2147483646;
  }
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

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

  it("昵称映射六种性格", () => {
    expect(profileByNickname("AI-紧凶")).toBe(AI_PROFILES.tightAggressive);
    expect(profileByNickname("AI-松凶")).toBe(AI_PROFILES.looseAggressive);
    expect(profileByNickname("AI-紧弱")).toBe(AI_PROFILES.tightPassive);
    expect(profileByNickname("AI-跟注站")).toBe(AI_PROFILES.callingStation);
    expect(profileByNickname("AI-疯狂")).toBe(AI_PROFILES.maniac);
    expect(profileByNickname("AI-岩石")).toBe(AI_PROFILES.rock);
    expect(profileByNickname("AI-未知性格")).toBe(AI_PROFILES.tightAggressive);
  });

  it("跟注站几乎不主动加注，弱牌也倾向跟注", () => {
    // canCheck 且中等偏弱牌：aggression=0.08、bluff=0.02，绝大多数随机序列应为过牌
    const check = chooseAiAction({
      hole: parseCards(["7h", "8d"]),
      community: parseCards(["2c", "7d", "9s"]),
      profile: AI_PROFILES.callingStation,
      pot: 100,
      toCall: 0,
      minRaiseTo: 50,
      maxRaiseTo: 200,
      chips: 300,
      canCheck: true,
      opponents: 2,
      rng: seededRng(42),
    });
    expect(check.action).toBe("check");
    // 面对小注：胜率高于底池赔率 → 跟注而非加注/弃牌
    const call = chooseAiAction({
      hole: parseCards(["7h", "8d"]),
      community: parseCards(["2c", "7d", "9s"]),
      profile: AI_PROFILES.callingStation,
      pot: 100,
      toCall: 20,
      minRaiseTo: 50,
      maxRaiseTo: 200,
      chips: 300,
      canCheck: false,
      opponents: 2,
      rng: seededRng(42),
    });
    expect(call.action).toBe("call");
  });

  it("疯狂风格下注频率显著高于跟注站", () => {
    const base = (rng: () => number) => ({
      hole: parseCards(["7h", "8d"]),
      community: parseCards(["2c", "7d", "9s"]),
      pot: 100,
      toCall: 0,
      minRaiseTo: 50,
      maxRaiseTo: 200,
      chips: 300,
      canCheck: true,
      opponents: 2,
      rng,
    });
    let maniacRaises = 0;
    let stationRaises = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      if (chooseAiAction({ ...base(seededRng(seed)), profile: AI_PROFILES.maniac }).action === "raise") {
        maniacRaises += 1;
      }
      if (
        chooseAiAction({ ...base(seededRng(seed + 1000)), profile: AI_PROFILES.callingStation })
          .action === "raise"
      ) {
        stationRaises += 1;
      }
    }
    expect(maniacRaises).toBeGreaterThanOrEqual(10);
    expect(maniacRaises).toBeGreaterThan(stationRaises * 3);
  });
});
