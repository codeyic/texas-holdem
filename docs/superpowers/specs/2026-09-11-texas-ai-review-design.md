# 德州扑克：AI 人机 + 实时胜率 + 打法复盘 设计文档

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this spec.

## Goal

在现有在线德州扑克（deploy/texas-holdem）中加入三块能力：

1. **AI 人机补位**：房间内可一键添加 AI 对手，AI 基于「范围 + EV」做决策，与真人同桌对战。
2. **实时胜率**：自己座位上实时显示当前胜率（服务端计算，随 state 下发）。
3. **打法复盘**：每手牌为真人玩家生成 HandRecord（每个决策点含实际 EV / 推荐动作 / 损失 BB / 漏洞标签），单手复盘 + 长期漏洞统计。

参考项目：https://github.com/Haotian14/Texas_Hold （单机训练器，核心链路「打牌 → 保存 HandRecord → 估算候选动作 EV → 标记失误 → 单手复盘 → 长期漏洞统计」）。

## Architecture

采用「服务端引擎全链路」方案：AI 决策、胜率计算、HandRecord 生成全部在服务端完成，客户端只做展示与本地持久化。AI 作为 `TablePlayer` 存在（`sessionId` 前缀 `ai://`），轮到行动时由服务端引擎调用现有 `applyAction` 通道，保证与真人走同一权威路径；复盘 EV 与 AI 决策共用同一套 equity/EV 链路，避免口径分裂。

```
server/engine/          ← 新增，纯逻辑，不依赖 UI/网络
├── equity.ts           # 胜率计算（翻前蒙特卡洛 + 翻后精确枚举）
├── handRange.ts        # 起手牌范围定义（按位置）
├── ai.ts               # AI 决策引擎（范围 + EV，多性格参数）
└── review.ts           # 复盘生成（HandRecord、EV、漏洞标签）

server/game/table.ts    # 扩展：AI 玩家支持、决策点记录钩子
server/room.ts          # 扩展：AI 行动调度、HandRecord 广播、胜率注入
server/index.ts         # 扩展：add_ai / add_ai 数量参数
shared/protocol.ts      # 扩展：addAI 消息、equity 字段、review 消息
client/src/             # 扩展：座位胜率显示、复盘面板、统计页(IndexedDB)
```

## Tech Stack

- TypeScript（严格模式）、Express + ws（现有）、React + Vite（现有）、Vitest（现有测试栈）
- IndexedDB（客户端本地存储，无需后端数据库）

---

## 已确认的设计决策

| 决策点 | 选择 |
|---|---|
| AI 使用形态 | 在线房间内加 AI 补位（房间一键添加） |
| 胜率展示形态 | 座位旁实时胜率 |
| 胜率可见范围 | **仅显示自己的**（真人玩家不应看到对手胜率，保持对局真实感） |
| 复盘粒度 | 完整闭环：决策点复盘 + 长期漏洞统计 |
| 复盘/统计存储 | 客户端 IndexedDB 本地保存 |
| AI 决策引擎 | 范围 + EV 完整版（参考项目同款） |
| 实现路径 | 方案 A：服务端引擎全链路 |

---

## 详细设计

### 1. 胜率引擎 `server/engine/equity.ts`

**职责**：给定自己的手牌 + 公共牌 + 对手范围，返回胜率（0~1）。

- **翻前**（无公共牌）：对自己手牌 vs 每个对手的**范围**做蒙特卡洛模拟（采样 N≈1000 次），N 可配置。
- **翻后**（有公共牌 ≥3）：精确枚举 ——
  - flop 后：剩余牌 47 选 2 = 1081 种，
  - turn 后：46 选 1 = 46 种，
  - river 后：直接摊牌评估。
- 复用现有 `server/game/evaluate.ts` 的 `bestHand` / `compareValue`。
- 多对手：对手各自用范围采样，最后统计自己赢 / 平 / 输。
- **范围抽象**：翻前对手手牌从其 preflop 范围中随机抽取；翻后可从该范围过滤（按动作历史缩小范围，MVP 阶段可只做位置/动作的粗略过滤）。

**对外接口**：

```ts
export function winEquity(opts: {
  heroCards: Card[];
  community: Card[];
  opponents: { range: HandRange | "random" }[];  // MVP: 至少支持 "random" 与一个简化范围
  iterations?: number;                            // 翻前采样次数，默认 1000
}): { win: number; tie: number; lose: number } // win+tie+lose = 1
```

### 2. 起手牌范围 `server/engine/handRange.ts`

**职责**：定义翻前起手牌范围，供 AI 翻前决策与胜率估算共用。

- 用牌型分类（口袋对 / 同花连张 / 同花 A 高 / 高张组合等）+ 位置调整的简化范围表。
- MVP：一张静态表 `{ 位置: [牌型分类集合] }`，如 BTN/CO/MP/UTG/SB/BB。
- 提供 `randomFromRange(range): Card[]` 与 `rangeContains(cards, range): boolean`。

### 3. AI 决策引擎 `server/engine/ai.ts`

**职责**：给定 AI 的手牌、公共牌、底池、当前注、对手范围，选出动作（fold/check/call/raise 到某金额 / allin）。

**EV 估算**：

- 对每个候选动作计算 EV：
  - fold：EV = 0（相对当前底池）
  - check/call：EV = winEquity × 赢得额 − (1−winEquity) × 跟注额
  - raise 到各档位：EV = winEquity × 底池结果 − 风险额（加诈唬期望调整）
- 简化模型（单街近似，参考项目口径）：**EV(action) = P(win) × (pot + call) − P(lose) × call**，raise 额外考虑弃牌赢率 FE（fold equity）：
  - `EV(raise) = FE × pot + (1−FE) × [P(win)×(pot+raise) − (1−P(win))×raise]`
- 加诈唬倾向、松紧参数做最终动作选择；全下当 maxRaiseTo 合理时优先考虑。

**性格参数**（构造时可调，MVP 提供 2~3 档预设）：`tightness`（松紧）、`aggression`（凶弱）、`bluffFreq`（诈唬频率）。

**对外接口**：

```ts
export interface AiProfile {
  name: string;          // 如 "紧凶"
  tightness: number;     // 0~1
  aggression: number;    // 0~1
  bluffFreq: number;     // 0~1
}

export function chooseAiAction(opts: {
  hole: Card[];
  community: Card[];
  profile: AiProfile;
  pot: number;
  toCall: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  chips: number;          // 本街可动用筹码
  canCheck: boolean;
  rng?: () => number;
}): { action: "fold" | "check" | "call" | "raise" | "allin"; raiseTo?: number }
```

### 4. 复盘生成 `server/engine/review.ts`

**职责**：将一手牌中某真人玩家的全部决策点整理成 `HandRecord`，供客户端复盘与统计。

**决策点记录**（服务端在每次 `applyAction` 前后采集）：

- `street`：preflop/flop/turn/river
- `position`：该玩家相对庄位的位置（SB/BB/EP/MP/CO/BTN）
- `heroCards`：手牌
- `community`：当时公共牌
- `pot`：当时底池
- `toCall`：需要跟注的金额
- `winEquity`：当时的胜率（复用 equity 引擎）
- `potOdds`：`toCall / (pot + toCall)`
- `actualAction` + `raiseTo`
- `recommendedAction`（由 EV 估算推荐）
- `evGap`：实际动作 EV 与推荐动作 EV 之差
- `lostBB`：`evGap / bigBlind`（负值即损失）
- `leakTags`：漏洞标签数组（见下）

**漏洞标签**（15 类参考项目，MVP 先实现最核心的 6~8 类）：

- `preflop_too_loose`（翻前太松：范围外起手牌跟注/加注）
- `preflop_missed_raise`（强牌只跟不拉）
- `calling_too_much`（跟注过多：potOdds 差还跟）
- `folding_strong`（强牌弃牌）
- `checking_strong`（强牌过牌不价值下注）
- `bluffing_too_often`（诈唬频率过高）
- `raising_too_small`（加注量过小）
- `chasing_draws`（追牌赔率不划算）

**对外接口**：

```ts
export interface HandRecord {
  handId: string;
  startedAt: number;
  smallBlind: number;
  bigBlind: number;
  positions: string[];
  decisions: DecisionPoint[];
  outcome: { wonChips: number; place: number; finalHand: string };
}

export function buildHandRecord(opts: {...}): HandRecord
```

### 5. 服务端集成

#### `server/game/table.ts` 扩展

- `addAiPlayer(nickname: string): TablePlayer`：与 `addPlayer` 类似，`sessionId = "ai://" + uuid`，`connected = true`。
- 添加 `isAi` 字段到 `TablePlayer`。
- 添加**决策点记录钩子**：在 `applyAction` 与 `afterAction` 的合理位置暴露内部状态（可新增 `collectDecisionContext(playerId)` 或让 Room 通过公开只读状态自行采集）。为减少侵入，倾向：**决策点采集放 Room 层**，Room 在每次广播前读取 table 的公开字段（holeCards、community、pot、currentBet 等）即可，不需要大改 table。
- `startHand` / `nextStreet` 已公开，AI 行动复用 `applyAction` 无需改。

#### `server/room.ts` 扩展

- **AI 行动调度**：`afterTableChange()` 广播后，若 `actorId` 对应玩家是 AI，则 `setTimeout(AI_DELAY_MS≈600, () => { 用 ai.chooseAiAction 计算动作 → table.applyAction → afterTableChange() })`。注意每次广播后都要检查，避免 AI 连发时遗漏。
- **胜率注入**：`snapshot()` 中为 `youPlayerId` 计算 `equity`（只在有手牌且底池>0 时算，翻前用蒙特卡洛、翻后用枚举）。AI 的胜率不下发。
- **HandRecord 生成**：`table.showdown` 结束后（`phase === "showdown"` 且 winners 已结算），为每个真人玩家 `buildHandRecord`，通过新增 `review` 消息单独发给对应玩家。
- **AI 计时器清理**：`dissolve()` / 房间销毁时清除挂起的 AI 行动 timer。

#### `server/index.ts` 扩展

- 新增 `add_ai` 消息处理：校验房主身份，调用 `table.addAiPlayer`，`room.broadcast()`。
- 房间创建 `createRoom` 可选参数（MVP 不需要，客户端建房后手动加 AI 即可）。

### 6. 协议扩展 `shared/protocol.ts`

```ts
// ClientMsg 新增：
| { type: "add_ai" }

// PublicState 新增：
equity: number | null;        // 仅自己，null 表示不可算（无手牌/无底池）
isAi: boolean;                // SeatDto 新增

// ServerMsg 新增：
| { type: "review"; record: HandRecord }
```

### 7. 客户端扩展 `client/src/`

- **App.tsx**：
  - 房主面板加「➕ 加 AI」按钮（发 `add_ai`）。
  - `SeatBlock` 自己的座位旁显示胜率（`equity` 转百分比，仅 `you` 显示）。
  - AI 座位渲染「🤖 AI」标识。
  - 收到 `review` 消息存入 IndexedDB，并弹出「查看复盘」入口。
- **新增 `client/src/review/`**：
  - `db.ts`：IndexedDB 封装（存/查 HandRecord，按时间/位置/漏洞过滤）。
  - `ReviewPanel.tsx`：单手复盘面板（决策点时间线，每点显示 EV/推荐/实际/损失 BB/漏洞标签）。
  - `StatsView.tsx`：长期统计（按位置、街、漏洞类型聚合，参考项目报表风格，简化版）。
  - 路由：在现有单页内加 hash 路由或顶部分区切换（桌台 / 复盘 / 统计）。

### 8. 测试

- **单元测试**（Vitest，沿现有 `server/**/*.test.ts` 模式）：
  - `equity.test.ts`：AA vs KK vs 随机（翻前胜率应在合理区间）；翻后精确枚举正确性（已知牌型必胜场景）。
  - `ai.test.ts`：强牌（AA/两对）倾向 raise/价值；弱牌面对大注倾向 fold；参数（紧/松、诈唬频率）改变行为方向。
  - `review.test.ts`：决策点 EV/推荐动作/漏洞标签与构造场景一致。
  - `table.test.ts`：`addAiPlayer` 不破坏发牌/盲注/回合顺序。
- **集成测试**：房间加 AI 后整手自动打牌不卡死、筹码守恒。
- **类型检查**：`tsc --noEmit`。

### 9. 错误处理与边界

- AI 无合法动作时走超时逻辑（`autoAct` 现有兜底）。
- 胜率计算失败/耗时过长：返回 `null`，客户端显示「—」。
- 蒙特卡洛在服务端同步执行，控制采样量（≤2000），避免阻塞事件循环；必要时可后续改为 worker。
- 房间销毁时清理 AI timer。
- IndexedDB 不可用（隐私模式）：降级为内存存储 + 提示。

---

## 范围外（YAGNI）

- 不做完整博弈树 Solver / 精确 GTO（参考项目同样不做，明确说明是近似）。
- 不做 seed 可复现牌局（在线多人场景价值低）。
- 不做 AI 难度档位细分（MVP 给 2~3 档预设即可）。
- 不做客户端本地 AI（保持服务端权威）。
- 不做翻后对手范围的精确手牌过滤（MVP 用位置/动作粗略过滤）。
- 不做聊天/录像回放等与本次目标无关的功能。

## 风险

- 蒙特卡洛与 EV 计算的性能：通过采样量控制 + 翻后精确枚举（量级很小）缓解。
- 参考项目为单机架构，移植需拆解其 `core/ai/review/session/storage` 到服务端/客户端两侧——本设计已按现有在线架构重新组织，不复用其耦合代码。
- AI 决策质量可能不如预期（简化单街 EV）：通过性格参数与测试校准，后续迭代升级。
