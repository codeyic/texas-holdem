import { describe, expect, it } from "vitest";
import { classifyLeaks, recommendAction } from "./review";

describe("复盘推荐与漏洞", () => {
  it("正赔率跟注不是漏洞", () => {
    const rec = recommendAction({
      winEquity: 0.4,
      pot: 200,
      toCall: 50, // potOdds = 50/250 = 0.2 < 0.4
      canCheck: false,
      minRaiseTo: 100,
      maxRaiseTo: 300,
      chips: 500,
    });
    expect(rec.action).toBe("call");
    expect(rec.leakTags).not.toContain("calling_too_much");
  });

  it("弱牌追大注 → calling_too_much 漏洞", () => {
    const rec = recommendAction({
      winEquity: 0.15,
      pot: 100,
      toCall: 200, // potOdds = 0.67 > 0.15
      canCheck: false,
      minRaiseTo: 400,
      maxRaiseTo: 900,
      chips: 900,
    });
    expect(rec.action).toBe("fold");
    expect(rec.leakTags).toContain("calling_too_much");
  });

  it("强牌可过牌却要弃牌 → folding_strong", () => {
    const rec = recommendAction({
      winEquity: 0.8,
      pot: 100,
      toCall: 0,
      canCheck: true,
      minRaiseTo: 50,
      maxRaiseTo: 300,
      chips: 500,
    });
    expect(rec.action).not.toBe("fold");
  });

  it("classifyLeaks 对比实际与推荐动作", () => {
    const tags = classifyLeaks({
      actualAction: "fold",
      recommendedAction: "raise",
      winEquity: 0.8,
      pot: 100,
      toCall: 0,
    });
    expect(tags).toContain("folding_strong");
  });
});
