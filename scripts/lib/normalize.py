"""One surface form for every source of the 20k set (docs/eval-dataset-plan.md §4.1): strip platform artifacts that
only some sources carry, so a judge cannot tell the label from the source. Words and punctuation are kept; markup and emoji
are removed (owner 2026-10-08: strip everything, keep it simple).
"""
import html
import re

from zhconv import convert

MAX_LEN = 200   # one length window for every source (comments, not articles)
MIN_LEN = 2

_URL = re.compile(r"(https?://|www\.)[^\s\u4e00-\u9fff]+|[A-Za-z0-9._-]+\.(com|cn|net|org)(/[^\s\u4e00-\u9fff]*)?", re.I)
_REPOST = re.compile(r"//\s*@[^:：\s@，。！？,.!?]{1,20}(?:[:：]|\s|$)")      # weibo repost chain  //@name:
_REPLY = re.compile(r"^\s*回复\s*@[^:：\s@，。！？,.!?]{1,20}(?:[:：]|\s|$)")   # reply prefix  回复@name:
_AT = re.compile(r"@[^:：\s@，。！？,.!?]{1,20}(?:[:：]|\s|$)")              # @name ended by colon/space/end; a bare "@" is dropped below
_EMOJI_CODE = re.compile(r"\[[\u4e00-\u9fa5a-zA-Z]{1,6}\]")   # [哈哈] style platform emoji codes
_HASHTAG = re.compile(r"#[^#\n]{1,30}#")                           # weibo #topic#
_UNICODE_EMOJI = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")
_WS = re.compile(r"\s+")


def normalize(t: str) -> str:
    t = html.unescape(str(t))
    t = convert(t, "zh-cn")                     # traditional -> simplified
    t = _URL.sub("", t)
    t = _REPLY.sub("", t)
    t = _REPOST.sub(" ", t)
    t = _AT.sub(" ", t).replace("@", "")       # an unterminated @name keeps its text (cannot tell name from content)
    t = _EMOJI_CODE.sub("", t)
    t = _HASHTAG.sub("", t)
    t = _UNICODE_EMOJI.sub("", t)                # only some sources carry emoji; the emoji perturbation adds them back later
    t = _WS.sub(" ", t)                          # newlines and runs of spaces -> one space
    return t.strip(" :：/")


def ok_length(t: str) -> bool:
    return MIN_LEN <= len(t) <= MAX_LEN
