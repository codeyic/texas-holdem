/** 单手复盘面板 */

import { useState } from "react";
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
  onClear,
  onBack,
}: {
  records: HandRecord[];
  onClear: () => void;
  onBack: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = records.find((r) => r.handId === selectedId) ?? null;

  if (records.length === 0) {
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
      <button type="button" className="ghost" onClick={onClear}>
        清空列表
      </button>
    </div>
  );
}
