import { describe, expect, it } from "vitest";
import { isQuickChatLine, QUICK_CHAT_LINES } from "./quickChat";

describe("快捷聊天用语", () => {
  it("白名单内的用语可以通过", () => {
    expect(QUICK_CHAT_LINES.length).toBeGreaterThan(0);
    expect(isQuickChatLine("快点啊……")).toBe(true);
    expect(isQuickChatLine("想偷鸡？")).toBe(true);
  });

  it("自定义句子不能发送", () => {
    expect(isQuickChatLine("随便打字")).toBe(false);
    expect(isQuickChatLine("")).toBe(false);
  });
});
