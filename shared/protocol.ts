/** 前后端共用的房间协议与公开状态结构 */

export type BlindPreset = "5/10" | "10/20" | "25/50";

export type ClientAction = "fold" | "check" | "call" | "raise" | "allin";

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

export interface CardDto {
  r: number;
  s: "s" | "h" | "d" | "c";
}

export interface SeatDto {
  playerId: string;
  nickname: string;
  seat: number;
  chips: number;
  betThisStreet: number;
  folded: boolean;
  allIn: boolean;
  inHand: boolean;
  connected: boolean;
  isHost: boolean;
  isDealer: boolean;
  isActor: boolean;
  isAi: boolean;
  /** 摊牌或已弃牌时可能亮出 */
  holeCards: CardDto[] | null;
  /** 拿了几手筹码（入座算 1，输光再拿 +1） */
  buyIns: number;
  /** 换设备重连用，全桌可见方便帮忙 */
  seatCode: string;
}

export interface LegalActionsDto {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
  canAllIn: boolean;
}

export interface PublicState {
  roomCode: string;
  phase: "idle" | "betting" | "showdown";
  street: Street | null;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  community: CardDto[];
  pot: number;
  currentBet: number;
  equity: number | null; // 仅自己，null 表示不可算
  actorId: string | null;
  actionDeadline: number | null;
  youPlayerId: string | null;
  yourCards: CardDto[] | null;
  legal: LegalActionsDto | null;
  seats: SeatDto[];
  winners: { playerId: string; amount: number; handName: string }[];
  log: string[];
  hostId: string;
  lanUrls: string[];
}

export interface RoomSummary {
  code: string;
  connected: number;
  seated: number;
  maxSeats: number;
  smallBlind: number;
  bigBlind: number;
  phase: "idle" | "betting" | "showdown";
  names: string[];
}

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
  // place: 1 = 本手赢到筹码（含平分底池的所有赢家），2 = 未赢
  outcome: { wonChips: number; place: number; finalHand: string };
}

export type NoticeKind = "join" | "leave" | "offline" | "reconnect" | "kick" | "info" | "error";

export type ServerMsg =
  | { type: "state"; state: PublicState }
  | { type: "error"; message: string }
  | { type: "notice"; text: string; kind: NoticeKind }
  | { type: "chat"; playerId: string; nickname: string; text: string }
  | { type: "review"; record: HandRecord };
