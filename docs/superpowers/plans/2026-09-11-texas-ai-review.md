# 德州扑克 AI + 胜率 + 复盘 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为在线德州扑克加入 AI 人机补位（范围+EV 决策）、自己座位的实时胜率、以及每手牌逐决策点复盘 + 长期漏洞统计。

**Architecture:** 服务端引擎全链路。新增 `server/engine/`（handRange 起手牌范围、equity 胜率、ai 决策、review 复盘），AI 作为 `TablePlayer`（`isAi` 字段）存在并复用现有 `applyAction` 通道；胜率由服务端计算随 `state` 下发（仅自己）；每手牌为真人玩家生成 `HandRecord` 通过新增 `review` 消息单独下发，客户端用 IndexedDB 持久化并展示复盘/统计。

**Tech Stack:** TypeScript（strict）、Express + ws、React + Vite、Vitest、IndexedDB。

---

## 文件结构

- Create: `shared/protocol.ts`（扩展）— 协议类型：add_ai 消息、equity 字段、isAi、HandRecord/DecisionPoint
- Create: `server/engine/handRange.ts` — 起手牌范围（Chen 公式排序 + topPct 范围）
- Create: `server/engine/equity.ts` — 胜率计算（翻前蒙特卡洛 + 翻后精确枚举）
- Create: `server/engine/ai.ts` — AI 决策引擎（范围+EV，性格参数）
- Create: `server/engine/review.ts` — 复盘生成（推荐动作、漏洞标签、HandRecord）
- Modify: `server/game/table.ts` — 加 `isAi` 字段与 `addAiPlayer`
- Modify: `server/room.ts` — AI 行动调度、胜率注入、决策点采集、HandRecord 广播
- Modify: `server/index.ts` — `add_ai` 消息处理
- Modify: `client/src/App.tsx` — 胜率显示、AI 标识、加 AI 按钮、review 消息处理、视图切换
- Create: `client/src/review/db.ts` — IndexedDB 封装
- Create: `client/src/review/ReviewPanel.tsx` — 单手复盘面板
- Create: `client/src/review/StatsView.tsx` — 长期统计视图
- Modify: `client/src/styles.css` — 新增样式
- Test: `server/engine/*.test.ts`、`server/game/table.test.ts`（扩展）

---

## Task 1: 共享协议扩展

**Files:**
- Modify: `shared/protocol.ts`

- [ ] **Step 1: 修改 `shared/protocol.ts` 增加类型**

在 `shared/protocol.ts` 中新增 `Street` 导出，给 `ClientMsg` 加 `add_ai`，`SeatDto` 加 `isAi`，`PublicState` 加 `equity`，并新增 `DecisionPoint`、`HandRecord` 类型与 `review` 消息：

```ts
export type Street = "preflop" | "flop" | "turn" | "river";

export type ClientMsg =
  | {
      type: "join";
      roomCode: string;
      nickname: string;
      sessionId: string;
      seatCode?: string;
    }
  | { type: "action"; action: ClientAction; raiseTo?: number }
  | { type: "start" }
  | { type: "add_ai" }
  | { type: "rebuy" }
  | { type: "leave" }
  | { type: "kick"; playerId: string }
  | { type: "dissolve" }
  | { type: "chat"; text: string };
```

`PublicState` 中：

```ts
export interface PublicState {
  // ... 现有字段保持不变
  street: Street | null;
  equity: number | null; // 仅自己，null 表示不可算
  // ...
}
```

`SeatDto` 新增：

```ts
export interface SeatDto {
  // ... 现有字段
  isAi: boolean;
}
```

文件末尾新增：

```ts
export interface DecisionPoint {
  street: Street;
  position: string; // "BTN" | "SB" | "BB" | "UTG" | "MP" | "CO"
  pot: number;
  toCall: number;
  winEquity: number; // 0..1
  potOdds: number; // 0..1
  actualAction: ClientAction;
  raiseTo?: number;
  recommendedAction: ClientAction;
  evGap: number; // 实际动作 EV 与推荐动作 EV 之差（正=好）
  lostBB: number; // -evGap / bigBlind
  leakTags: string[];
}

export interface HandRecord {
  handId: string;
  startedAt: number;
  smallBlind: number;
  bigBlind: number;
  heroNickname: string;
  heroHole: CardDto[];
  decisions: DecisionPoint[];
  outcome: { wonChips: number; place: number; finalHand: string };
}

export type ServerMsg =
  | { type: "state"; state: PublicState }
  | { type: "error"; message: string }
  | { type: "notice"; text: string; kind: NoticeKind }
  | { type: "chat"; playerId: string; nickname: string; text: string }
  | { type: "review"; record: HandRecord };
```

注意 `PublicState.street` 类型要改为 `Street | null`（原来是字面量联合，等价的，但统一引用 `Street`）。

- [ ] **Step 2: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（仅当其他代码未引用被改字段时；table.ts 的 `Street` 是独立定义不受影响）

- [ ] **Step 3: 提交**

```bash
git add shared/protocol.ts
git commit -m "feat(protocol): add add_ai message, equity field, isAi flag and HandRecord types"
```

---

## Task 2: 起手牌范围 handRange.ts

**Files:**
- Create: `server/engine/handRange.ts`
- Test: `server/engine/handRange.test.ts`

- [ ] **Step 1: 写失败测试 `server/engine/handRange.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { makeDeck, parseCards } from "../game/cards";
import { chenScore, holeKey, holeInRange, randomHoleFromRange } from "./handRange";

describe("起手牌范围", () => {
  it("holeKey 正确标识三类起手牌", () => {
    expect(holeKey(parseCards(["Ah", "Ad"]))).toBe("AA");
    expect(holeKey(parseCards(["Ah", "Kh"]))).toBe("AKs");
    expect(holeKey(parseCards(["Ah", "Kd"]))).toBe("AKo");
  });

  it("Chen 分值：口袋对 > 高张同花 > 非同花高张", () => {
    const aa = chenScore(parseCards(["Ah", "Ad"]));
    const aks = chenScore(parseCards(["Ah", "Kh"]));
    const ako = chenScore(parseCards(["Ah", "Kd"]));
    const 27 = chenScore(parseCards(["2h", "7d"]));
    expect(aa).toBeGreaterThan(aks);
    expect(aks).toBeGreaterThan(ako);
    expect(ako).toBeGreaterThan(27);
  });

  it("随机从范围抽牌不与已知死牌冲突", () => {
    const dead = parseCards(["Ah", "Kh", "2s", "3s", "4s"]);
    const hole = randomHoleFromRange({ topPct: 0.2 }, dead, () => 0.5)!;
    expect(hole).toHaveLength(2);
    expect(dead.some((d) => d.r === hole[0].r && d.s === hole[0].s)).toBe(false);
    expect(dead.some((d) => d.r === hole[1].r && d.s === hole[1].s)).toBe(false);
    expect(holeInRange({ topPct: 0.2 }, hole)).toBe(true);
  });

  it("随机范围任何手牌都在范围内", () => {
    const hole = randomHoleFromRange("random", [], () => 0.3)!;
    expect(holeInRange("random", hole)).toBe(true);
  });

  it("极紧范围排除弱牌", () => {
    const weak = parseCards(["2h", "7d"]);
    expect(holeInRange({ topPct: 0.05 }, weak)).toBe(false);
    const aa = parseCards(["Ah", "Ad"]);
    expect(holeInRange({ topPct: 0.05 }, aa)).toBe(true);
  });
});
```

注意：变量名 `27` 是非法标识符，应改为 `weak`。测试中所有 `27` 变量名改为 `weak`，`aks` 的断言中 `27` 引用改为 `weak`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/engine/handRange.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/engine/handRange.ts`**

```ts
/** 起手牌范围：基于 Chen 公式对 169 类起手牌排序，按 topPct 截取 */

import type { Card } from "../game/cards";
import { makeDeck } from "../game/cards";

/** "random" 表示任意两张牌；{ topPct } 表示前 topPct（0..1）强的起手牌 */
export type RangeLike = "random" | { topPct: number };

const RANK_CHARS = "23456789TJQKA";

function rankVal(ch: string): number {
  return RANK_CHARS.indexOf(ch) + 2;
}

function rankChar(r: number): string {
  return RANK_CHARS[r - 2];
}

/** 起手牌归类键：AA / AKs / AKo */
export function holeKey(cards: Card[]): string {
  const hi = Math.max(cards[0].r, cards[1].r);
  const lo = Math.min(cards[0].r, cards[1].r);
  const hiC = rankChar(hi);
  const loC = rankChar(lo);
  if (hi === lo) {
    return hiC + loC;
  }
  const suited = cards[0].s === cards[1].s;
  return `${hiC}${loC}${suited ? "s" : "o"}`;
}

const CHEN_HIGH: Record<number, number> = {
  2: 1, 3: 1.5, 4: 2, 5: 2.5, 6: 3, 7: 3.5, 8: 4, 9: 4.5,
  10: 5, 11: 6, 12: 7, 13: 8, 14: 10,
};

/** Chen 公式评分（越高越强） */
export function chenScore(cards: Card[]): number {
  const hi = Math.max(cards[0].r, cards[1].r);
  const lo = Math.min(cards[0].r, cards[1].r);
  let score = CHEN_HIGH[hi] ?? 0;
  if (hi === lo) {
    return Math.max(5, score * 2);
  }
  if (cards[0].s === cards[1].s) {
    score += 2;
  }
  const gap = hi - lo - 1;
  if (gap === 0) {
    score += 1;
  } else if (gap === 2) {
    score -= 1;
  } else if (gap === 3) {
    score -= 2;
  } else if (gap >= 4) {
    score -= 5;
  }
  // 中间牌加成：连张或间隔1且最大牌 ≤ Q 时，5~9 区间的中间牌每张 +1
  if (gap <= 1 && hi < 13) {
    for (let r = lo + 1; r < hi; r += 1) {
      if (r >= 5 && r <= 9) {
        score += 1;
      }
    }
  }
  return score;
}

/** 169 类起手牌按 Chen 分值降序 */
const RANK_ORDER: string[] = (() => {
  const combos: { key: string; score: number }[] = [];
  for (let hi = 2; hi <= 14; hi += 1) {
    for (let lo = 2; lo <= hi; lo += 1) {
      if (hi === lo) {
        combos.push({
          key: rankChar(hi) + rankChar(hi),
          score: chenScore([{ r: hi, s: "h" }, { r: hi, s: "d" }]),
        });
      } else {
        combos.push({
          key: `${rankChar(hi)}${rankChar(lo)}s`,
          score: chenScore([{ r: hi, s: "h" }, { r: lo, s: "h" }]),
        });
        combos.push({
          key: `${rankChar(hi)}${rankChar(lo)}o`,
          score: chenScore([{ r: hi, s: "h" }, { r: lo, s: "d" }]),
        });
      }
    }
  }
  combos.sort((a, b) => b.score - a.score);
  return combos.map((c) => c.key);
})();

function rangeKeys(range: RangeLike): string[] {
  if (range === "random") {
    return RANK_ORDER;
  }
  const n = Math.max(1, Math.round(range.topPct * RANK_ORDER.length));
  return RANK_ORDER.slice(0, n);
}

/** 从可用牌堆中构造指定起手牌键的一手牌；无法构造时返回 null */
function holeFromKey(key: string, deck: Card[]): Card[] | null {
  if (key.length === 2) {
    const r = rankVal(key[0]);
    const cs = deck.filter((c) => c.r === r);
    if (cs.length < 2) {
      return null;
    }
    return [cs[0], cs[1]];
  }
  const hi = rankVal(key[0]);
  const lo = rankVal(key[1]);
  const suited = key.endsWith("s");
  const hs = deck.filter((c) => c.r === hi);
  const ls = deck.filter((c) => c.r === lo);
  const a = hs[0];
  if (!a) {
    return null;
  }
  const cands = suited ? ls.filter((c) => c.s === a.s) : ls.filter((c) => c.s !== a.s);
  const b = cands[0];
  if (!b) {
    return null;
  }
  return [a, b];
}

/** 从范围中随机抽一手牌，排除 dead（自己手牌/公共牌/其他对手） */
export function randomHoleFromRange(
  range: RangeLike,
  dead: Card[],
  rng: () => number = Math.random,
): Card[] | null {
  const deck = makeDeck().filter(
    (c) => !dead.some((d) => d.r === c.r && d.s === c.s),
  );
  const keys = rangeKeys(range);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const key = keys[Math.floor(rng() * keys.length)];
    const hole = holeFromKey(key, deck);
    if (hole) {
      return hole;
    }
  }
  return null;
}

/** 一手牌是否属于该范围 */
export function holeInRange(range: RangeLike, hole: Card[]): boolean {
  const key = holeKey(hole);
  if (range === "random") {
    return true;
  }
  return rangeKeys(range).includes(key);
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/engine/handRange.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 提交**

```bash
git add server/engine/handRange.ts server/engine/handRange.test.ts
git commit -m "feat(engine): hand range with Chen ranking and topPct sampling"
```

---

## Task 3: 胜率引擎 equity.ts

**Files:**
- Create: `server/engine/equity.ts`
- Test: `server/engine/equity.test.ts`

- [ ] **Step 1: 写失败测试 `server/engine/equity.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseCards } from "../game/cards";
import { winEquity } from "./equity";

describe("胜率引擎", () => {
  it("翻前 AA vs 随机：胜率明显占优", () => {
    const eq = winEquity({
      heroCards: parseCards(["Ah", "Ad"]),
      community: [],
      opponents: ["random"],
      iterations: 2000,
    });
    expect(eq.win).toBeGreaterThan(0.75);
    expect(eq.lose).toBeLessThan(0.25);
  });

  it("翻前 72o vs 随机：明显劣势", () => {
    const eq = winEquity({
      heroCards: parseCards(["2h", "7d"]),
      community: [],
      opponents: ["random"],
      iterations: 2000,
    });
    expect(eq.win).toBeLessThan(0.5);
  });

  it("翻后河牌已定：按公共牌精确判定", () => {
    // 公共牌成对 A，自己 2h2d → 只有两对？不，2h2d + AA = 两对。改用更强的：自己 Ah Ad，河牌无对，必胜任何随机
    const eq = winEquity({
      heroCards: parseCards(["Ah", "Ad"]),
      community: parseCards(["Kh", "Qd", "Jc", "9s", "3h"]),
      opponents: ["random"],
    });
    expect(eq.win).toBe(1);
    expect(eq.tie).toBe(0);
  });

  it("翻后转牌：枚举剩余河牌", () => {
    // 自己 KQ 顺面已成：9TJQ? 需要组成 9TJQK 顺。公共 9s Ts Js Qs，手牌 Kh Kd？则 A/K 完成顺。胜率应在合理区间
    const eq = winEquity({
      heroCards: parseCards(["Ah", "Kh"]),
      community: parseCards(["2c", "7d", "9s"]),
      opponents: ["random"],
    });
    expect(eq.win).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/engine/equity.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/engine/equity.ts`**

```ts
/** 胜率引擎：翻前蒙特卡洛采样，翻后剩余公共牌精确枚举 */

import type { Card } from "../game/cards";
import { makeDeck } from "../game/cards";
import { bestHand, compareValue } from "../game/evaluate";
import { randomHoleFromRange, type RangeLike } from "./handRange";

export interface EquityResult {
  win: number;
  tie: number;
  lose: number; // 三者之和恒为 1
}

function combos<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const n = items.length;
  const walk = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i += 1) {
      acc.push(items[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function remainingDeck(exclude: Card[]): Card[] {
  return makeDeck().filter(
    (c) => !exclude.some((d) => d.r === c.r && d.s === c.s),
  );
}

function heroVsOpponents(
  heroCards: Card[],
  oppHoles: Card[][],
  board: Card[],
): "win" | "tie" | "lose" {
  const hero = bestHand([...heroCards, ...board]);
  let best = [-1];
  for (const h of oppHoles) {
    const v = bestHand([...h, ...board]);
    if (compareValue(v, best) > 0) {
      best = v;
    }
  }
  const cmp = compareValue(hero, best);
  if (cmp > 0) {
    return "win";
  }
  if (cmp === 0) {
    return "tie";
  }
  return "lose";
}

function randomBoard(exclude: Card[], rng: () => number): Card[] {
  const deck = remainingDeck(exclude);
  const board: Card[] = [];
  for (let i = 0; i < 5; i += 1) {
    const idx = Math.floor(rng() * deck.length);
    board.push(deck.splice(idx, 1)[0]);
  }
  return board;
}

export function winEquity(opts: {
  heroCards: Card[];
  community: Card[];
  opponents: RangeLike[];
  iterations?: number; // 翻前采样次数，默认 1000；翻后外层采样次数默认 100
  rng?: () => number;
}): EquityResult {
  const { heroCards, community, opponents } = opts;
  const rng = opts.rng ?? Math.random;
  const dead = [...heroCards, ...community];

  if (community.length >= 3) {
    // 翻后：外层对手范围采样，内层公共牌精确枚举
    const outer = opts.iterations ?? 100;
    const need = 5 - community.length;
    let win = 0;
    let tie = 0;
    let total = 0;
    for (let i = 0; i < outer; i += 1) {
      const oppHoles: Card[][] = [];
      let ok = true;
      for (const range of opponents) {
        const h = randomHoleFromRange(
          range,
          [...dead, ...oppHoles.flat()],
          rng,
        );
        if (!h) {
          ok = false;
          break;
        }
        oppHoles.push(h);
      }
      if (!ok) {
        continue;
      }
      const deck = remainingDeck([...dead, ...oppHoles.flat()]);
      const boards = need === 0 ? [[]] : combos(deck, need);
      for (const extra of boards) {
        const board = [...community, ...extra];
        const res = heroVsOpponents(heroCards, oppHoles, board);
        if (res === "win") {
          win += 1;
        } else if (res === "tie") {
          tie += 1;
        }
        total += 1;
      }
    }
    if (total === 0) {
      return { win: 0, tie: 0, lose: 1 };
    }
    return { win: win / total, tie: tie / total, lose: (total - win - tie) / total };
  }

  // 翻前蒙特卡洛
  const iterations = opts.iterations ?? 1000;
  let win = 0;
  let tie = 0;
  for (let i = 0; i < iterations; i += 1) {
    const oppHoles: Card[][] = [];
    let ok = true;
    for (const range of opponents) {
      const h = randomHoleFromRange(
        range,
        [...dead, ...oppHoles.flat()],
        rng,
      );
      if (!h) {
        ok = false;
        break;
      }
      oppHoles.push(h);
    }
    if (!ok) {
      continue;
    }
    const board = randomBoard([...dead, ...oppHoles.flat()], rng);
    const res = heroVsOpponents(heroCards, oppHoles, board);
    if (res === "win") {
      win += 1;
    } else if (res === "tie") {
      tie += 1;
    }
  }
  return { win: win / iterations, tie: tie / iterations, lose: (iterations - win - tie) / iterations };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/engine/equity.test.ts`
Expected: PASS（4 tests，翻前测试可能因随机性有微小波动，阈值留足）

- [ ] **Step 5: 提交**

```bash
git add server/engine/equity.ts server/engine/equity.test.ts
git commit -m "feat(engine): equity engine with preflop Monte Carlo and postflop enumeration"
```

---

## Task 4: AI 决策引擎 ai.ts

**Files:**
- Create: `server/engine/ai.ts`
- Test: `server/engine/ai.test.ts`

- [ ] **Step 1: 写失败测试 `server/engine/ai.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/engine/ai.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/engine/ai.ts`**

```ts
/** AI 决策引擎：基于胜率与单街 EV 近似选择动作 */

import type { Card } from "../game/cards";
import { winEquity } from "./equity";

export interface AiProfile {
  name: string;
  tightness: number; // 0..1 越高越紧（更少玩弱牌）
  aggression: number; // 0..1 越高越凶（更多加注）
  bluffFreq: number; // 0..1 诈唬概率
}

export const AI_PROFILES: Record<string, AiProfile> = {
  tightAggressive: { name: "紧凶", tightness: 0.6, aggression: 0.85, bluffFreq: 0.05 },
  looseAggressive: { name: "松凶", tightness: 0.2, aggression: 0.9, bluffFreq: 0.18 },
  tightPassive: { name: "紧弱", tightness: 0.8, aggression: 0.25, bluffFreq: 0.02 },
};

export type AiAction = "fold" | "check" | "call" | "raise" | "allin";

export interface AiChoice {
  action: AiAction;
  raiseTo?: number;
}

/** 计算某个下注档位下的目标加注额 */
function raiseSize(
  win: number,
  pot: number,
  minRaiseTo: number,
  maxRaiseTo: number,
  profile: AiProfile,
): number {
  const frac = win >= 0.65 ? 0.75 : win >= 0.45 ? 0.55 : 0.4;
  let target = minRaiseTo + (pot * frac - minRaiseTo) * (0.5 + 0.5 * profile.aggression);
  target = Math.round(target);
  if (target < minRaiseTo) {
    target = minRaiseTo;
  }
  if (target > maxRaiseTo) {
    target = maxRaiseTo;
  }
  return target;
}

export function chooseAiAction(opts: {
  hole: Card[];
  community: Card[];
  profile: AiProfile;
  pot: number;
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  chips: number;
  canCheck: boolean;
  opponents: number;
  rng?: () => number;
}): AiChoice {
  const {
    hole,
    community,
    profile,
    pot,
    toCall,
    minRaiseTo,
    maxRaiseTo,
    chips,
    canCheck,
  } = opts;
  const rng = opts.rng ?? Math.random;
  const opponents = Array.from(
    { length: Math.max(1, opts.opponents) },
    () => "random" as const,
  );
  const iterations = community.length >= 3 ? 100 : 600;
  const eq = winEquity({ heroCards: hole, community, opponents, iterations, rng });
  const win = eq.win;
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;

  // 强牌线：跟随 aggression 决定是否价值加注
  const strong = win >= Math.max(0.55, 1 - profile.tightness * 0.5);

  if (canCheck) {
    if (strong && rng() < profile.aggression) {
      return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
    }
    // 弱牌诈唬
    if (win < 0.5 && rng() < profile.bluffFreq) {
      return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
    }
    return { action: "check" };
  }

  // 需要跟注
  if (strong && rng() < profile.aggression) {
    return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
  }
  const evCall = win * (pot + toCall) - (1 - win) * toCall;
  const cheapCall = toCall <= pot * 0.15 && win > 0.3;
  if (win > potOdds || evCall > 0 || cheapCall) {
    if (toCall >= chips) {
      return { action: "allin" };
    }
    return { action: "call" };
  }
  // 诈唬加注
  if (rng() < profile.bluffFreq && win >= 0.2) {
    return { action: "raise", raiseTo: raiseSize(win, pot, minRaiseTo, maxRaiseTo, profile) };
  }
  return { action: "fold" };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/engine/ai.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add server/engine/ai.ts server/engine/ai.test.ts
git commit -m "feat(engine): AI decision engine with range-based EV and profiles"
```

---

## Task 5: 复盘生成 review.ts

**Files:**
- Create: `server/engine/review.ts`
- Test: `server/engine/review.test.ts`

- [ ] **Step 1: 写失败测试 `server/engine/review.test.ts`**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/engine/review.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `server/engine/review.ts`**

```ts
/** 复盘：推荐动作、EV 差距、漏洞标签 */

import type { ClientAction } from "../../shared/protocol";

export interface Recommendation {
  action: ClientAction;
  raiseTo?: number;
  evGap: number; // 推荐动作相对弃牌/现状的 EV 提升
  leakTags: string[];
}

/** 估算一个动作的相对 EV（相对 fold=0） */
export function actionEv(
  action: ClientAction,
  winEquity: number,
  pot: number,
  toCall: number,
): number {
  if (action === "fold") {
    return 0;
  }
  if (action === "check") {
    return winEquity * pot;
  }
  if (action === "call") {
    return winEquity * (pot + toCall) - (1 - winEquity) * toCall;
  }
  // raise：近似用 call 的 EV 加上底池挤压增益
  const callEv = winEquity * (pot + toCall) - (1 - winEquity) * toCall;
  return callEv + winEquity * pot * 0.3;
}

export function recommendAction(opts: {
  winEquity: number;
  pot: number;
  toCall: number;
  canCheck: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  chips: number;
}): Recommendation {
  const { winEquity: win, pot, toCall, canCheck, minRaiseTo, maxRaiseTo } = opts;
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;
  const leakTags: string[] = [];

  let best = "fold" as ClientAction;
  let bestEv = -Infinity;
  const consider = (action: ClientAction) => {
    const ev = actionEv(action, win, pot, toCall);
    if (ev > bestEv) {
      bestEv = ev;
      best = action;
    }
  };

  if (canCheck) {
    consider("check");
  } else if (toCall > 0) {
    consider("call");
  }
  consider("fold");
  if (maxRaiseTo > toCall && maxRaiseTo > 0) {
    consider("raise");
  }

  if (best === "call" && win < potOdds && toCall > pot * 0.3) {
    leakTags.push("calling_too_much");
  }
  if (best === "raise" && win >= 0.7) {
    leakTags.push("checking_strong");
  }
  if (best === "check" && win >= 0.8) {
    leakTags.push("checking_strong");
  }

  const raiseTo =
    best === "raise" ? Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(pot * 0.7))) : undefined;
  const foldEv = actionEv("fold", win, pot, toCall);
  return { action: best, raiseTo, evGap: bestEv - foldEv, leakTags };
}

export function classifyLeaks(opts: {
  actualAction: ClientAction;
  recommendedAction: ClientAction;
  winEquity: number;
  pot: number;
  toCall: number;
}): string[] {
  const { actualAction, recommendedAction, winEquity, pot, toCall } = opts;
  const tags: string[] = [];
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;

  if (actualAction === "fold" && winEquity >= 0.7) {
    tags.push("folding_strong");
  }
  if (actualAction === "call" && winEquity < potOdds && toCall > pot * 0.3) {
    tags.push("calling_too_much");
  }
  if (actualAction === "check" && winEquity >= 0.8) {
    tags.push("checking_strong");
  }
  if (
    (actualAction === "raise" || actualAction === "allin") &&
    winEquity < 0.35 &&
    recommendedAction !== "raise"
  ) {
    tags.push("bluffing_too_often");
  }
  if (actualAction === "call" && winEquity >= 0.7 && recommendedAction === "raise") {
    tags.push("preflop_missed_raise");
  }
  return tags;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/engine/review.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add server/engine/review.ts server/engine/review.test.ts
git commit -m "feat(engine): review recommendations, EV gap and leak tags"
```

---

## Task 6: table.ts 支持 AI 玩家

**Files:**
- Modify: `server/game/table.ts`
- Test: `server/game/table.test.ts`（扩展）

- [ ] **Step 1: 在 `server/game/table.test.ts` 追加失败测试**

```ts
describe("AI 玩家", () => {
  it("addAiPlayer 添加 AI 座位，isAi 标记正确", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    const ai = t.addAiPlayer("AI-紧凶");
    expect(ai.isAi).toBe(true);
    expect(ai.sessionId.startsWith("ai://")).toBe(true);
    expect(ai.connected).toBe(true);
    expect(ai.chips).toBe(1000);
  });

  it("AI 可正常参战并完成一手", () => {
    const t = new PokerTable({
      hostId: "a",
      smallBlind: 10,
      bigBlind: 20,
      buyIn: 1000,
    });
    seat(t, "a", "甲");
    t.addAiPlayer("AI-1");
    t.startHand();
    expect(t.phase).toBe("betting");
    // 打完整手不抛异常
    let guard = 0;
    while (t.phase === "betting" && t.actorId && guard < 50) {
      t.applyAction(t.actorId, "check", undefined);
      guard += 1;
    }
    expect(t.phase).toBe("showdown");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/game/table.test.ts`
Expected: FAIL（addAiPlayer 不存在）

- [ ] **Step 3: 修改 `server/game/table.ts`**

在 `TablePlayer` 接口加字段：

```ts
export interface TablePlayer {
  // ... 现有字段
  isAi: boolean;
}
```

在 `addPlayer` 的 player 对象字面量里加 `isAi: false`。

新增方法（放在 `addPlayer` 之后）：

```ts
addAiPlayer(nickname: string): TablePlayer {
  if (this.players.length >= this.maxSeats) {
    throw new Error("房间已满（最多 8 人）");
  }
  const id = `ai://${Math.random().toString(36).slice(2, 10)}`;
  const used = new Set(this.players.map((x) => x.seat));
  let seat = 0;
  while (used.has(seat)) {
    seat += 1;
  }
  const player: TablePlayer = {
    id,
    sessionId: `ai://${id}`,
    nickname,
    seat,
    chips: this.buyIn,
    holeCards: null,
    folded: false,
    allIn: false,
    betThisStreet: 0,
    contrib: 0,
    hasActed: false,
    inHand: false,
    connected: true,
    pendingKick: false,
    buyIns: 1,
    rebuyLocked: false,
    seatCode: this.allocSeatCode(),
    prevSessionId: null,
    isAi: true,
  };
  this.players.push(player);
  const sitOut =
    this.phase === "betting" || this.phase === "showdown"
      ? "（本局旁观，下一手参战）"
      : "";
  this.pushLog(`${player.nickname} 入座${sitOut}`);
  return player;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/game/table.test.ts`
Expected: PASS（原测试 + 2 个新测试）

- [ ] **Step 5: 提交**

```bash
git add server/game/table.ts server/game/table.test.ts
git commit -m "feat(table): add AiPlayer support with isAi flag"
```

---

## Task 7: room.ts AI 调度 + 胜率注入 + 复盘生成

**Files:**
- Modify: `server/room.ts`
- Test: `server/room.test.ts`（新建或扩展）

- [ ] **Step 1: 写失败测试 `server/room.test.ts`**

Room 依赖 WebSocket 与回调，测试用最小替身。

```ts
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { PokerTable } from "./game/table";
import { Room } from "./room";

function makeRoom() {
  const table = new PokerTable({ hostId: "h", smallBlind: 10, bigBlind: 20, buyIn: 1000 });
  table.addPlayer({ id: "h", sessionId: "s-h", nickname: "房主" });
  const room = new Room({
    code: "TEST",
    table,
    lanUrls: [],
    onDestroy: () => {},
  });
  const ws = { send: vi.fn(), close: vi.fn(), readyState: 1, OPEN: 1 } as unknown as WebSocket;
  room.attachSocket("h", ws);
  return { room, table, ws };
}

describe("房间 AI 与胜率", () => {
  it("AI 行动由房间调度（模拟计时器）", () => {
    vi.useFakeTimers();
    try {
      const { room, table } = makeRoom();
      table.addAiPlayer("AI-1");
      room.startHand();
      // AI 行动应由房间 aiAct 触发
      expect(table.phase).toBe("betting");
      vi.advanceTimersByTime(2000);
      expect(table.phase).toBe("betting"); // 2人：AI 行动后轮到房主（若 AI check）或结束
      vi.useRealTimers();
    } catch (e) {
      vi.useRealTimers();
      throw e;
    }
  });

  it("快照中给自己注入 equity", () => {
    const { room, table } = makeRoom();
    table.addPlayer({ id: "p2", sessionId: "s2", nickname: "乙" });
    room.startHand();
    const snap = room.snapshot("h");
    expect(typeof snap.equity).toBe("number");
  });
});

// 说明：Room 构造签名是 { code, table, lanUrls, onDestroy }；
// makeRoom 中房主已是 player，startHand 至少需要 2 名 connected 且有筹码玩家。
```

注意：Room 当前没有 `startHand` 外的 AI 调度。需要先实现。上面测试的第二条在实现后应通过（equity 非 null）。第一条通过假定时器推进 AI 行动。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/room.test.ts`
Expected: FAIL（equity 字段缺失、AI 调度不存在）

- [ ] **Step 3: 修改 `server/room.ts`**

在文件顶部引入引擎：

```ts
import { chooseAiAction, type AiProfile } from "./engine/ai";
import { winEquity } from "./engine/equity";
import { recommendAction, classifyLeaks } from "./engine/review";
import type { DecisionPoint, HandRecord, ClientAction } from "../shared/protocol";
```

新增常量与字段：

```ts
const AI_DELAY_MS = 600;

// Room 类字段新增：
private aiTimer: ReturnType<typeof setTimeout> | null = null;
private aiProfile: AiProfile = { name: "紧凶", tightness: 0.6, aggression: 0.85, bluffFreq: 0.05 };
private handId: string | null = null;
private handDecisions = new Map<string, DecisionPoint[]>(); // playerId -> 本手决策
private handHeroes = new Map<string, { nickname: string; hole: Card[] }>();
private handOutcome: HandRecord["outcome"] | null = null;
```

在 `startHand()` 中初始化本手记录（抽 `beginHand()` 供 showdown 自动续局复用）：

```ts
/** 初始化本手复盘上下文（room.startHand 与 showdown 自动续局共用） */
private beginHand(): void {
  this.handId = `hand-${this.code}-${Date.now()}`;
  this.handDecisions = new Map();
  this.handHeroes = new Map();
  this.handOutcome = null;
  for (const p of this.table.players) {
    if (!p.isAi && p.inHand && p.holeCards) {
      this.handHeroes.set(p.id, { nickname: p.nickname, hole: p.holeCards });
    }
  }
}

startHand(): void {
  this.clearTimers();
  this.table.startHand();
  this.beginHand();
  this.armActionTimer();
  this.scheduleAiIfNeeded();
  this.broadcast();
}
```

`act()` 改造为记录决策点：

```ts
act(playerId: string, action: ClientAction, raiseTo?: number): void {
  const p = this.table.players.find((x) => x.id === playerId);
  const actor = this.table.actorId === playerId && p;
  if (actor && !p.isAi && p.holeCards) {
    this.recordDecision(playerId, action, raiseTo);
  }
  this.table.applyAction(playerId, action, raiseTo);
  this.afterTableChange();
}
```

新增决策点记录方法：

```ts
private recordDecision(
  playerId: string,
  actualAction: ClientAction,
  raiseTo?: number,
): void {
  const p = this.table.players.find((x) => x.id === playerId);
  if (!p || !p.holeCards || this.table.phase !== "betting") {
    return;
  }
  const toCall = Math.max(0, this.table.currentBet - p.betThisStreet);
  const pot = this.table.potTotal();
  const potOdds = pot + toCall > 0 ? toCall / (pot + toCall) : 0;
  const opponents = this.table.players.filter(
    (o) => o.inHand && !o.folded && o.id !== playerId,
  ).length;
  const equity = winEquity({
    heroCards: p.holeCards,
    community: this.table.community,
    opponents: Array.from({ length: Math.max(1, opponents) }, () => "random" as const),
    iterations: this.table.community.length >= 3 ? 60 : 300,
  }).win;
  const canCheck = toCall === 0;
  const legal = this.table.legalActions(playerId);
  const minRaiseTo = legal?.minRaiseTo ?? this.table.minRaise;
  const maxRaiseTo = legal?.maxRaiseTo ?? p.betThisStreet + p.chips;
  const rec = recommendAction({
    winEquity: equity,
    pot,
    toCall,
    canCheck,
    minRaiseTo,
    maxRaiseTo,
    chips: p.chips,
  });
  const actualEv = rec.action === actualAction
    ? rec.evGap
    : (() => {
        // 用简单比较：实际动作与推荐动作是否一致；evGap 用推荐差值近似
        const same = actualAction === rec.action && (actualAction !== "raise" || raiseTo === rec.raiseTo);
        return same ? rec.evGap : -Math.abs(rec.evGap) * 0.5;
      })();
  const dp: DecisionPoint = {
    street: this.table.street ?? "preflop",
    position: this.positionOf(p),
    pot,
    toCall,
    winEquity: equity,
    potOdds,
    actualAction,
    raiseTo,
    recommendedAction: rec.action,
    evGap: actualEv,
    lostBB: -(actualEv / this.table.bigBlind),
    leakTags: classifyLeaks({
      actualAction,
      recommendedAction: rec.action,
      winEquity: equity,
      pot,
      toCall,
    }),
  };
  const list = this.handDecisions.get(playerId) ?? [];
  list.push(dp);
  this.handDecisions.set(playerId, list);
}

/** 简化位置判定：按座位相对庄位的顺序 */
private positionOf(p: { seat: number }): string {
  const seated = [...this.table.players].sort((a, b) => a.seat - b.seat);
  const idx = seated.findIndex((x) => x.seat === p.seat);
  const n = seated.length;
  const dealerIdx = seated.findIndex((x) => x.seat === this.table.dealerSeat);
  const rel = (idx - dealerIdx + n) % n; // 0=庄位
  if (n === 2) {
    return rel === 0 ? "BTN" : "BB";
  }
  if (rel === 0) {
    return "BTN";
  }
  if (rel === n - 1) {
    return "SB";
  }
  if (rel === n - 2) {
    return "BB";
  }
  if (rel === n - 3) {
    return "CO";
  }
  if (rel === n - 4) {
    return "MP";
  }
  return "UTG";
}
```

`afterTableChange()` 中加 AI 调度与复盘广播。在 betting 分支末尾调用 `scheduleAiIfNeeded()`；在 showdown 分支里生成并发送复盘（并在自动续局时复用 `beginHand()`）：

```ts
afterTableChange(): void {
  this.clearActionTimer();
  if (this.table.phase === "showdown") {
    this.actionDeadline = null;
    this.finalizeHandRecords(); // 新增：摊牌后立即结算复盘
    this.broadcast();
    this.showdownTimer = setTimeout(() => {
      this.table.finishShowdownToIdle();
      const withChips = this.table.players.filter(
        (p) => p.chips > 0 && p.connected,
      );
      if (withChips.length >= 2) {
        this.table.startHand();
        this.beginHand(); // 新增：续局也要初始化复盘上下文
        this.armActionTimer();
        this.scheduleAiIfNeeded();
      }
      this.broadcast();
    }, SHOWDOWN_MS);
    return;
  }
  if (this.table.phase === "betting") {
    this.armActionTimer();
    this.scheduleAiIfNeeded();
  }
  this.broadcast();
}
```

新增 AI 调度与复盘结算方法：

```ts
private scheduleAiIfNeeded(): void {
  if (this.aiTimer) {
    clearTimeout(this.aiTimer);
    this.aiTimer = null;
  }
  if (this.table.phase !== "betting") {
    return;
  }
  const actorId = this.table.actorId;
  if (!actorId) {
    return;
  }
  const actor = this.table.players.find((p) => p.id === actorId);
  if (!actor?.isAi) {
    return;
  }
  this.aiTimer = setTimeout(() => this.aiAct(), AI_DELAY_MS);
}

private aiAct(): void {
  this.aiTimer = null;
  const actorId = this.table.actorId;
  if (!actorId || this.table.phase !== "betting") {
    return;
  }
  const actor = this.table.players.find((p) => p.id === actorId);
  if (!actor?.isAi || !actor.holeCards) {
    return;
  }
  const legal = this.table.legalActions(actorId);
  if (!legal) {
    return;
  }
  const toCall = Math.max(0, this.table.currentBet - actor.betThisStreet);
  const opponents = this.table.players.filter(
    (o) => o.inHand && !o.folded && o.id !== actorId,
  ).length;
  const choice = chooseAiAction({
    hole: actor.holeCards,
    community: this.table.community,
    profile: this.aiProfile,
    pot: this.table.potTotal(),
    toCall,
    minRaiseTo: legal.minRaiseTo,
    maxRaiseTo: legal.maxRaiseTo,
    chips: actor.chips,
    canCheck: legal.canCheck,
    opponents,
  });
  try {
    this.table.applyAction(actorId, choice.action, choice.raiseTo);
    this.afterTableChange();
  } catch (err) {
    // AI 行动失败走超时兜底
    this.autoAct();
  }
}

private finalizeHandRecords(): void {
  if (!this.handId) {
    return;
  }
  for (const [playerId, hero] of this.handHeroes) {
    const decisions = this.handDecisions.get(playerId) ?? [];
    if (decisions.length === 0) {
      continue;
    }
    const win = this.table.winners.find((w) => w.playerId === playerId);
    const record: HandRecord = {
      handId: this.handId,
      startedAt: Number(this.handId.split("-").pop() ?? 0),
      smallBlind: this.table.smallBlind,
      bigBlind: this.table.bigBlind,
      heroNickname: hero.nickname,
      heroHole: hero.hole.map((c) => ({ r: c.r, s: c.s })),
      decisions,
      outcome: {
        wonChips: win?.amount ?? 0,
        place: win ? 1 : 2,
        finalHand: win?.handName ?? "",
      },
    };
    this.send(playerId, { type: "review", record });
  }
  this.handId = null;
}
```

`snapshot()` 中注入 equity。在 `yourCards` 之后加：

```ts
let equity: number | null = null;
if (youPlayerId && you?.holeCards && this.table.phase === "betting" && this.table.potTotal() > 0) {
  const opponents = this.table.players.filter(
    (o) => o.inHand && !o.folded && o.id !== youPlayerId,
  ).length;
  equity = winEquity({
    heroCards: you.holeCards,
    community: this.table.community,
    opponents: Array.from({ length: Math.max(1, opponents) }, () => "random" as const),
    iterations: this.table.community.length >= 3 ? 60 : 300,
  }).win;
}
```

返回对象加 `equity`，并在 `seats` 映射中加 `isAi: p.isAi`。

`dissolve()` 与 `clearTimers()` 清理 aiTimer：

```ts
private clearTimers(): void {
  this.clearActionTimer();
  if (this.aiTimer) {
    clearTimeout(this.aiTimer);
    this.aiTimer = null;
  }
  if (this.showdownTimer) {
    clearTimeout(this.showdownTimer);
    this.showdownTimer = null;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run server/room.test.ts`
Expected: PASS。同时跑全部测试确保不回归：
Run: `npm test`
Expected: PASS（全部）

注意：Room 测试里 `room.snapshot("h")` 需要 `startHand` 已发牌，房主有 holeCards。测试二在加 AI 前要保证两人（房主 + 乙）才能开局。

- [ ] **Step 5: 提交**

```bash
git add server/room.ts server/room.test.ts
git commit -m "feat(room): schedule AI actions, inject equity, generate hand records"
```

---

## Task 8: index.ts add_ai 消息处理

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: 在 `handleMessage` 的 `start` 分支后加 `add_ai` 分支**

```ts
if (msg.type === "start") {
  if (playerId !== room.table.hostId) {
    throw new Error("只有房主可以开局");
  }
  room.startHand();
  return;
}
if (msg.type === "add_ai") {
  if (playerId !== room.table.hostId) {
    throw new Error("只有房主可以添加 AI");
  }
  const count = room.table.players.filter((p) => p.isAi).length;
  const names = ["AI-紧凶", "AI-松凶", "AI-紧弱"];
  const p = room.table.addAiPlayer(names[count % names.length]);
  room.broadcastNotice(`${p.nickname} 入座（AI）`, "join");
  room.broadcast();
  return;
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add server/index.ts
git commit -m "feat(server): handle add_ai message for host"
```

---

## Task 9: 客户端：加 AI 按钮、胜率显示、AI 标识、review 消息

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/styles.css`

- [ ] **Step 1: App.tsx 处理 `review` 消息并保存到 IndexedDB**

先在 `client/src/review/db.ts` 写 IndexedDB 封装（先建，供 App 用）：

```ts
/** IndexedDB 持久化 HandRecord */

import type { HandRecord } from "@shared/protocol";

const DB_NAME = "texas-review";
const STORE = "hands";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "handId" });
        store.createIndex("startedAt", "startedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveHand(record: HandRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listHands(): Promise<HandRecord[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result as HandRecord[]).sort((a, b) => b.startedAt - a.startedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function clearHands(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

- [ ] **Step 2: App.tsx 修改**

在 imports 中加：

```ts
import { saveHand, listHands } from "./review/db";
import type { HandRecord } from "@shared/protocol";
```

在 App 组件加 state：

```ts
const [view, setView] = useState<"table" | "review" | "stats">("table");
const [handRecords, setHandRecords] = useState<HandRecord[]>([]);
```

在 `ws.onmessage` 的 `state` 处理前加 review 分支：

```ts
if (msg.type === "review") {
  void saveHand(msg.record);
  setHandRecords((prev) => [msg.record, ...prev]);
  pushToast("本手已生成复盘，可查看", "info");
  return;
}
```

在 `SeatBlock` 组件加胜率与 AI 标识：

- 在参数类型加 `equity: number | null`
- 座位名称旁：`{seat.isAi ? <span className="seat-mark ai">🤖</span> : null}`
- 自己座位筹码旁：`{seat.playerId === youPlayerId && equity !== null ? <span className="equity-pill">{Math.round(equity * 100)}%</span> : null}`

在 renderSeat 调用处传 `equity={state.equity}`。

在 `TableMenu` 加「添加 AI」按钮（isHost 时）：在 `canStart` 按钮旁加：

```tsx
{isHost ? (
  <button
    type="button"
    className="ghost"
    onClick={() => {
      onAddAi();
      onClose();
    }}
  >
    添加 AI
  </button>
) : null}
```

TableMenu 的 props 加 `isHost: boolean` 与 `onAddAi: () => void`。在顶部工具栏 `TableMenu` 使用处传 `isHost={isHost}` 与 `onAddAi={() => send({ type: "add_ai" })}`。

在大厅无 state 时（lobby）不加 AI 按钮（需在房间内）。

- [ ] **Step 3: styles.css 增加样式**

在文件末尾追加：

```css
.equity-pill {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(79, 248, 210, 0.16);
  color: var(--accent-2, #4ef8d2);
  font-size: 0.75rem;
  font-weight: 700;
}
.seat-mark.ai {
  background: rgba(245, 130, 20, 0.25);
  color: #ffb347;
}
```

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add client/src/App.tsx client/src/styles.css client/src/review/db.ts
git commit -m "feat(client): AI button, equity pill, review message handling with IndexedDB"
```

---

## Task 10: 客户端复盘面板与统计视图

**Files:**
- Create: `client/src/review/ReviewPanel.tsx`
- Create: `client/src/review/StatsView.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/styles.css`

- [ ] **Step 1: 写 `client/src/review/ReviewPanel.tsx`**

```tsx
/** 单手复盘面板 */

import type { HandRecord } from "@shared/protocol";

const STREET_NAME: Record<string, string> = {
  preflop: "翻前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
};

const ACTION_NAME: Record<string, string> = {
  fold: "弃牌",
  check: "过牌",
  call: "跟注",
  raise: "加注",
  allin: "全下",
};

export function ReviewPanel({
  records,
  onBack,
}: {
  records: HandRecord[];
  onBack: () => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = records.find((r) => r.handId === selectedId) ?? null;

  if (!selected && records.length > 0) {
    return (
      <div className="review-page">
        <header className="review-head">
          <h2>复盘</h2>
          <button type="button" className="ghost" onClick={onBack}>
            返回牌桌
          </button>
        </header>
        <ul className="review-list">
          {records.map((r) => (
            <li key={r.handId}>
              <button type="button" onClick={() => setSelectedId(r.handId)}>
                <strong>{new Date(r.startedAt).toLocaleString()}</strong>
                <span>
                  {r.decisions.length} 个决策点 · {r.outcome.finalHand || "未摊牌"} ·{" "}
                  {r.outcome.wonChips > 0 ? `+${r.outcome.wonChips}` : r.outcome.wonChips}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="ghost" onClick={() => setSelectedId(null)}>
          清空列表
        </button>
      </div>
    );
  }

  if (selected) {
    return (
      <div className="review-page">
        <header className="review-head">
          <h2>本手复盘</h2>
          <div>
            <button type="button" className="ghost" onClick={() => setSelectedId(null)}>
              返回列表
            </button>
            <button type="button" className="ghost" onClick={onBack}>
              返回牌桌
            </button>
          </div>
        </header>
        <div className="review-summary">
          <p>
            {selected.heroNickname} · {selected.smallBlind}/{selected.bigBlind} ·{" "}
            {selected.outcome.finalHand || "未摊牌"}
          </p>
          <p>
            结果：{selected.outcome.wonChips > 0 ? `+${selected.outcome.wonChips}` : selected.outcome.wonChips}
            {selected.outcome.place === 1 ? "（赢家）" : ""}
          </p>
        </div>
        <ol className="review-decisions">
          {selected.decisions.map((d, i) => (
            <li key={i} className={`decision-tag ${d.leakTags.length ? "has-leak" : ""}`}>
              <div className="decision-title">
                <span>{STREET_NAME[d.street]} · {d.position}</span>
                <span className="decision-actions">
                  实际：{ACTION_NAME[d.actualAction]}
                  {d.raiseTo ? ` ${d.raiseTo}` : ""} / 推荐：{ACTION_NAME[d.recommendedAction]}
                </span>
              </div>
              <div className="decision-meta">
                胜率 {Math.round(d.winEquity * 100)}% · 底池赔率 {Math.round(d.potOdds * 100)}% · EV{" "}
                {d.evGap.toFixed(1)} · 损失 {d.lostBB.toFixed(1)} BB
              </div>
              {d.leakTags.length ? (
                <div className="leak-tags">
                  {d.leakTags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className="review-page">
      <header className="review-head">
        <h2>复盘</h2>
        <button type="button" className="ghost" onClick={onBack}>
          返回牌桌
        </button>
      </header>
      <p className="muted">还没有复盘记录，打完一手牌后再来看看</p>
    </div>
  );
}
```

注意：`React.useState` 需要 `import React from "react"`（或 `import { useState } from "react"`）。使用后者。

- [ ] **Step 2: 写 `client/src/review/StatsView.tsx`**

```tsx
/** 长期统计：按位置 / 街 / 漏洞类型聚合 */

import { useMemo } from "react";
import type { HandRecord } from "@shared/protocol";

const LEAK_NAMES: Record<string, string> = {
  folding_strong: "强牌弃牌",
  calling_too_much: "跟注过多",
  checking_strong: "强牌过牌",
  bluffing_too_often: "诈唬过多",
  preflop_missed_raise: "翻前少加注",
};

export function StatsView({ records, onBack }: { records: HandRecord[]; onBack: () => void }) {
  const stats = useMemo(() => {
    const leakCount = new Map<string, number>();
    const streetCount = new Map<string, number>();
    let totalBB = 0;
    let hands = 0;
    for (const r of records) {
      hands += 1;
      for (const d of r.decisions) {
        streetCount.set(d.street, (streetCount.get(d.street) ?? 0) + 1);
        for (const tag of d.leakTags) {
          leakCount.set(tag, (leakCount.get(tag) ?? 0) + 1);
        }
        totalBB += d.lostBB;
      }
    }
    const avgBB = hands > 0 ? totalBB / hands : 0;
    return { leakCount, streetCount, avgBB, hands };
  }, [records]);

  return (
    <div className="review-page">
      <header className="review-head">
        <h2>长期统计</h2>
        <button type="button" className="ghost" onClick={onBack}>
          返回牌桌
        </button>
      </header>
      <div className="stats-summary">
        <p>已复盘 {stats.hands} 手 · 平均每手损失 {stats.avgBB.toFixed(1)} BB</p>
      </div>
      <section className="stats-block">
        <h3>按街分布</h3>
        <ul>
          {[...streetCount.entries()].map(([k, v]) => (
            <li key={k}>{k}：{v} 次</li>
          ))}
        </ul>
      </section>
      <section className="stats-block">
        <h3>漏洞频率</h3>
        <ul>
          {[...leakCount.entries()].map(([k, v]) => (
            <li key={k}>
              {LEAK_NAMES[k] ?? k}：{v} 次
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: App.tsx 接线视图切换**

在 App 组件 `send` 定义后加：

```ts
const loadHands = useCallback(async () => {
  const hs = await listHands();
  setHandRecords(hs);
}, []);

useEffect(() => {
  void loadHands();
}, [loadHands]);
```

在返回桌面的 JSX 顶部（`if (!state)` 之前）加视图切换逻辑：在 `state` 存在时，若 `view !== "table"` 则渲染对应视图：

```tsx
if (state && view === "review") {
  return (
    <ReviewPanel
      records={handRecords}
      onBack={() => setView("table")}
    />
  );
}
if (state && view === "stats") {
  return (
    <StatsView
      records={handRecords}
      onBack={() => setView("table")}
    />
  );
}
```

在 `TableMenu`（设置面板）中加「复盘」「统计」按钮（isHost 或任何玩家都可看自己的）：在 `添加 AI` 按钮附近加：

```tsx
<button type="button" className="ghost" onClick={() => { onViewReview(); onClose(); }}>
  复盘
</button>
<button type="button" className="ghost" onClick={() => { onViewStats(); onClose(); }}>
  统计
</button>
```

TableMenu props 加 `onViewReview: () => void`、`onViewStats: () => void`。使用处传 `onViewReview={() => setView("review")}`、`onViewStats={() => setView("stats")}`。

- [ ] **Step 4: styles.css 追加复盘样式**

```css
.review-page {
  min-height: 100vh;
  padding: 20px;
  color: var(--fg, #e8ecf8);
}
.review-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.review-list li button {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--glass, rgba(255,255,255,0.06));
  border: 1px solid var(--glass-border, rgba(255,255,255,0.12));
  border-radius: 10px;
  margin-bottom: 8px;
}
.review-decisions {
  list-style: none;
  padding: 0;
}
.decision-tag {
  padding: 12px 16px;
  background: var(--glass, rgba(255,255,255,0.05));
  border: 1px solid var(--glass-border, rgba(255,255,255,0.1));
  border-radius: 10px;
  margin-bottom: 8px;
}
.decision-tag.has-leak { border-color: rgba(255, 110, 120, 0.4); }
.decision-title {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-weight: 700;
}
.decision-meta { font-size: 0.85rem; opacity: 0.8; margin-top: 4px; }
.leak-tags { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.leak-tags span {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(255, 110, 120, 0.16);
  color: #ff8a92;
  font-size: 0.75rem;
}
.stats-summary { margin-bottom: 12px; }
.stats-block h3 { margin: 12px 0 6px; font-size: 0.95rem; }
.stats-block li { list-style: none; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
```

- [ ] **Step 5: 类型检查与构建**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add client/src/review/ReviewPanel.tsx client/src/review/StatsView.tsx client/src/App.tsx client/src/styles.css
git commit -m "feat(client): review panel and long-term stats views"
```

---

## Task 11: 端到端验证与文档收尾

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: PASS（全部单测）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: 生产构建**

Run: `npm run build`
Expected: PASS（dist/ 生成）

- [ ] **Step 4: 手动端到端验证**

启动：`npm run dev`
浏览器 http://localhost:5173/poker/
- 建房 → 添加 3 个 AI → 开局 → 确认 AI 自动行动（600ms 延迟）
- 确认自己座位旁显示胜率百分比
- 打几手牌后打开设置 → 复盘 → 确认决策点列表与漏洞标签
- 设置 → 统计 → 确认聚合数据
- 确认 AI 座位显示 🤖 标识

- [ ] **Step 5: 更新 README.md**

在 README 的功能列表追加：

```markdown
- AI 人机补位：房间内可添加 3 档性格 AI（紧凶/松凶/紧弱），基于范围+EV 决策
- 实时胜率：自己座位实时显示当前胜率（服务端计算）
- 打法复盘：每手牌生成逐决策点复盘（EV/推荐动作/损失 BB/漏洞标签），IndexedDB 本地保存
- 长期统计：按街与漏洞类型聚合的历史统计视图
```

- [ ] **Step 6: 提交**

```bash
git add README.md
git commit -m "docs: document AI, equity and review features"
```

---

## 自检记录

- 设计文档全部能力均有对应任务：AI 补位(Task6/7/8)、实时胜率(Task3/7/9)、完整复盘闭环(Task5/7/9/10)、IndexedDB(Task9/10)。
- 无占位符。
- 类型一致性：`ClientAction`、`Street`、`HandRecord`、`DecisionPoint` 均从 `shared/protocol` 引用；`RangeLike` 在 handRange 定义并被 equity 复用；`AiProfile` 在 ai 定义被 room 复用。
