import { describe, expect, it } from "vitest";
import { isLandCompactSize, isLandscapeSize, layoutViewport, shouldPromptLandscape } from "./viewport";

describe("视口横竖屏", () => {
  it("宽大于等于高视为横屏", () => {
    expect(isLandscapeSize(800, 360)).toBe(true);
    expect(isLandscapeSize(360, 800)).toBe(false);
    expect(isLandscapeSize(400, 400)).toBe(true);
  });

  it("仅小屏竖屏才提示横过来，避免卡住无法操作", () => {
    expect(shouldPromptLandscape(390, 844)).toBe(true);
    expect(shouldPromptLandscape(844, 390)).toBe(false);
    expect(shouldPromptLandscape(1280, 800)).toBe(false);
  });

  it("横屏且高度较矮时用紧凑牌桌", () => {
    expect(isLandCompactSize(800, 360)).toBe(true);
    expect(isLandCompactSize(1024, 768)).toBe(false);
    expect(isLandCompactSize(360, 800)).toBe(false);
  });

  it("假横屏时宽高对调，真横屏不再对调", () => {
    expect(layoutViewport(390, 844, true)).toEqual({ width: 844, height: 390 });
    expect(layoutViewport(844, 390, true)).toEqual({ width: 844, height: 390 });
    expect(layoutViewport(390, 844, false)).toEqual({ width: 390, height: 844 });
  });
});
