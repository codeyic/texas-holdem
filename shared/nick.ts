/** 进房默认随机昵称，减少输入 */

const ADJ = [
  "快乐",
  "冷静",
  "大胆",
  "幸运",
  "摸鱼",
  "佛系",
  "王者",
  "暴躁",
  "元气",
  "稳赢",
];

const NOUN = [
  "熊猫",
  "狐狸",
  "鲨鱼",
  "兔子",
  "企鹅",
  "橘猫",
  "柯基",
  "海豚",
  "浣熊",
  "柴犬",
];

export function randomNickname(rng: () => number = Math.random): string {
  const a = ADJ[Math.floor(rng() * ADJ.length)] ?? "快乐";
  const n = NOUN[Math.floor(rng() * NOUN.length)] ?? "熊猫";
  const num = Math.floor(rng() * 90) + 10;
  return `${a}${n}${num}`;
}

export function uniqueNickname(
  taken: (name: string) => boolean,
  preferred?: string,
  rng: () => number = Math.random,
): string {
  const want = (preferred ?? "").trim();
  if (want && !taken(want)) {
    return want;
  }
  for (let i = 0; i < 40; i += 1) {
    const name = randomNickname(rng);
    if (!taken(name)) {
      return name;
    }
  }
  return `玩家${Math.floor(rng() * 9000) + 1000}`;
}
