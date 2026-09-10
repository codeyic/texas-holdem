import { describe, expect, it } from "vitest";
import { holeCardsSpeech } from "../shared/cardsSpeech";

describe("手牌读法", () => {
  it("读出花色与点数", () => {
    expect(
      holeCardsSpeech([
        { r: 14, s: "s" },
        { r: 13, s: "h" },
      ]),
    ).toBe("你的手牌是黑桃A和红桃K");
  });
});
