/** 对外挂载路径与公网源，对应 https://codeyc.top/poker/ */

export const PUBLIC_BASE = "/poker";

/** 手机扫码 / 分享必须用公网 HTTPS，勿用局域网 IP */
export const PUBLIC_ORIGIN = "https://codeyc.top";

export function publicPageUrl(): string {
  return `${PUBLIC_ORIGIN}${PUBLIC_BASE}/`;
}

export function publicJoinUrl(roomCode: string): string {
  return `${publicPageUrl()}?room=${encodeURIComponent(roomCode.toUpperCase())}`;
}
