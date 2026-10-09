"""scripts/owner-review-apply.py on a synthetic sheet and label rows (no dataset text)."""
import importlib.util
import os

import pytest

_SPEC = importlib.util.spec_from_file_location("ora", os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "owner-review-apply.py"))
ora = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ora)

SHEET = """# 验证集交负责人判定的条目
## 辱骂：2 条
### abuse-1　`a1`
三方投票：deepseek allow
> 示例
负责人判定：违规 明显针对个人
### abuse-2　`a2`
> 示例
负责人判定：
## 营销：1 条
### marketing-1　`m1`
> 示例
负责人判定：允许
"""


def test_parse_reads_decisions_notes_and_blanks():
    got = ora.parse(SHEET.splitlines())
    assert got == [("abuse-v4.3", "a1", "violate", "明显针对个人"), ("abuse-v4.3", "a2", None, ""), ("marketing-v2", "m1", "allow", "")]


def test_unknown_word_stops():
    with pytest.raises(ValueError, match="unknown decision"):
        ora.parse("### abuse-1　`a1`\n负责人判定：大概违规".splitlines())


def test_apply_only_touches_owner_items_and_keeps_votes():
    rows = [{"id": "a1", "standard": "abuse-v4.3", "label": "uncertain", "source": "owner", "votes": {"ds": "allow"}},
            {"id": "a9", "standard": "abuse-v4.3", "label": "allow", "source": "consensus"}]
    out, c = ora.apply(rows, {"a1": ("violate", "明显针对个人")})
    assert out[0] == {"id": "a1", "standard": "abuse-v4.3", "label": "violate", "source": "owner_decided", "votes": {"ds": "allow"}, "owner_note": "明显针对个人"}
    assert out[1] == rows[1] and c == {"violate": 1}
    with pytest.raises(ValueError, match="not an owner item"):
        ora.apply(rows, {"a9": ("violate", "")})
    with pytest.raises(ValueError, match="not in the label file"):
        ora.apply(rows, {"zz": ("allow", "")})
