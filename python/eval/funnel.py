"""Two-threshold funnel on one score (dev plan 2026-10-08 §2.3; review finding: thresholds taken from quantiles were
never checked, so with tied scores a "5% false block" target could hide 100% false blocks while reporting 0% to agent).

Items with score < t pass automatically, items with score >= u are blocked automatically, the rest go to the agent.
  t = the largest observed score value whose ACTUAL leak (violating items with score < t, as a share of violating
      items) is within the leak target;
  u = the smallest observed score value whose ACTUAL false-block rate (normal items with score >= u, as a share of
      normal items) is within the false-block target; +inf (block nothing) when no value qualifies.
If u < t the regions overlap; blocking wins there, so the effective pass threshold becomes u. Both rates are recomputed
at the thresholds actually used and returned with the targets, so a report can never claim a target it did not meet.
"""
import math


def funnel(scores, labels, leak_target, fb_target):
    pos = [s for s, y in zip(scores, labels) if y == 1]
    neg = [s for s, y in zip(scores, labels) if y == 0]
    if not pos or not neg:
        raise ValueError("funnel needs both violating (1) and normal (0) items")
    cands = sorted(set(scores)) + [math.inf]
    leak = lambda t: sum(1 for s in pos if s < t) / len(pos)
    fb = lambda u: sum(1 for s in neg if s >= u) / len(neg)
    t = max((c for c in cands if leak(c) <= leak_target), default=min(cands))
    u = min(c for c in cands if fb(c) <= fb_target)   # +inf always qualifies (fb = 0)
    t_eff = min(t, u)
    n = len(scores)
    return {
        "leak_target": leak_target, "fb_target": fb_target,
        "leak_actual": leak(t_eff), "fb_actual": fb(u),
        "pass_below": t_eff, "block_at_or_above": u,
        "to_agent": sum(1 for s in scores if t_eff <= s < u) / n,
        "n": n, "n_violating": len(pos), "n_normal": len(neg),
    }
