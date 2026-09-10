/**
 * 牌桌快捷用语（斗地主式点选），仅允许白名单，避免自由输入刷屏。
 */

export const QUICK_CHAT_LINES: string[] = [
  "快点啊……",
  "我等到花都谢了",
  "你牌打得真好",
  "别吵了，专心打牌",
  "又断线了",
  "不好意思啊",
  "这把我赢定了",
  "我有事先走了",
  "想偷鸡？",
];

export function isQuickChatLine(text: string): boolean {
  if (!text) {
    return false;
  }
  return QUICK_CHAT_LINES.includes(text);
}
