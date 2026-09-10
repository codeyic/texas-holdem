/** 长期统计：按街与漏洞类型聚合 */

import { useMemo } from "react";
import type { HandRecord } from "@shared/protocol";

const STREET_NAME: Record<string, string> = {
  preflop: "翻前",
  flop: "翻牌",
  turn: "转牌",
  river: "河牌",
};

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
          {[...stats.streetCount.entries()].map(([k, v]) => (
            <li key={k}>{STREET_NAME[k] ?? k}：{v} 次</li>
          ))}
        </ul>
      </section>
      <section className="stats-block">
        <h3>漏洞频率</h3>
        <ul>
          {[...stats.leakCount.entries()].map(([k, v]) => (
            <li key={k}>
              {LEAK_NAMES[k] ?? k}：{v} 次
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
