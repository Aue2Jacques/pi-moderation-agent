import math

from eval.funnel import funnel


def test_all_scores_tied_cannot_meet_the_false_block_target_so_everything_goes_to_the_agent():
    # the reviewed bug: quantile thresholds reported 0% to agent here while the actual false block was 100%
    r = funnel([0.9] * 200, [1] * 100 + [0] * 100, 0.15, 0.05)
    assert r["fb_actual"] == 0.0 and r["block_at_or_above"] == math.inf
    assert r["leak_actual"] <= 0.15
    assert r["to_agent"] == 1.0


def test_separable_scores_need_no_agent():
    r = funnel([0.1] * 50 + [0.95] * 50, [0] * 50 + [1] * 50, 0.10, 0.03)
    assert r["to_agent"] == 0.0 and r["leak_actual"] == 0.0 and r["fb_actual"] == 0.0


def test_actual_rates_never_exceed_targets():
    scores = [i / 100 for i in range(100)] * 3
    labels = [1 if (i % 100) >= 40 else 0 for i in range(300)]
    for lt, ft in ((0.15, 0.05), (0.10, 0.03), (0.0, 0.0)):
        r = funnel(scores, labels, lt, ft)
        assert r["leak_actual"] <= lt + 1e-12 and r["fb_actual"] <= ft + 1e-12
        assert 0.0 <= r["to_agent"] <= 1.0


def test_partial_ties_at_the_boundary_are_counted_not_split():
    # 10 normal items tied at 0.8 with 10 violating ones: blocking at 0.8 would block all 10 normal (50%)
    scores = [0.1] * 10 + [0.8] * 10 + [0.8] * 10 + [0.99] * 10
    labels = [0] * 10 + [0] * 10 + [1] * 10 + [1] * 10
    r = funnel(scores, labels, 0.25, 0.05)   # passing below 0.99 would leak the 10 tied violating items (50%)
    assert r["block_at_or_above"] == 0.99 and r["fb_actual"] == 0.0
    assert r["pass_below"] == 0.8 and r["leak_actual"] == 0.0
    assert r["to_agent"] == 0.5
