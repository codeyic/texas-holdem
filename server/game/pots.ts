/** 按投入筹码拆主池与边池 */

export interface Contrib {
  id: string;
  amount: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  eligible: string[];
}

export function buildPots(contrib: Contrib[]): Pot[] {
  const levels = [...new Set(contrib.map((c) => c.amount))]
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    const involved = contrib.filter((p) => p.amount >= level);
    const amount = (level - prev) * involved.length;
    const eligible = involved.filter((p) => !p.folded).map((p) => p.id);
    if (amount > 0) {
      pots.push({ amount, eligible });
    }
    prev = level;
  }
  return mergeSameEligible(pots);
}

function mergeSameEligible(pots: Pot[]): Pot[] {
  const merged: Pot[] = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    const same =
      last &&
      last.eligible.length === pot.eligible.length &&
      last.eligible.every((id, i) => id === pot.eligible[i]);
    if (same && last) {
      last.amount += pot.amount;
    } else {
      merged.push({ amount: pot.amount, eligible: [...pot.eligible] });
    }
  }
  return merged;
}
