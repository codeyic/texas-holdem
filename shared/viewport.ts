/**
 * 用宽高判断横竖屏。部分内置浏览器不更新 CSS orientation，不能只靠媒体查询。
 */

export function isLandscapeSize(width: number, height: number): boolean {
  return width >= height;
}

export function isLandCompactSize(width: number, height: number): boolean {
  if (!isLandscapeSize(width, height)) {
    return false;
  }
  return height <= 560;
}

export function shouldPromptLandscape(width: number, height: number): boolean {
  if (isLandscapeSize(width, height)) {
    return false;
  }
  return Math.min(width, height) <= 900;
}

/** 微信无法转屏时，用 CSS 旋转，布局宽高对调 */
export function layoutViewport(
  width: number,
  height: number,
  fakeLandscape: boolean,
): { width: number; height: number } {
  if (!fakeLandscape) {
    return { width, height };
  }
  if (isLandscapeSize(width, height)) {
    return { width, height };
  }
  return { width: height, height: width };
}
