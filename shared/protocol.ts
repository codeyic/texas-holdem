/** 前后端共用的房间协议与公开状态结构 */

export type BlindPreset = "5/10" | "10/20" | "25/50";

export type ClientAction = "fold" | "check" | "call" | "raise" | "allin";

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
  street: "preflop" | "flop" | "turn" | "river" | null;
  smallBlind: number;
  bigBlind: number;
  buyIn: number;
  community: CardDto[];
  pot: number;
  currentBet: number;
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

export type NoticeKind = "join" | "leave" | "offline" | "reconnect" | "kick" | "info";

export type ServerMsg =
  | { type: "state"; state: PublicState }
  | { type: "error"; message: string }
  | { type: "notice"; text: string; kind: NoticeKind }
  | { type: "chat"; playerId: string; nickname: string; text: string };
