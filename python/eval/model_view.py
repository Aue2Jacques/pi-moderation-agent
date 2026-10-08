"""Model view (dev plan E5): the text a judge sees. Same rules as packages/core/src/model-view.ts; both must pass
rules/model-view-cases.json. Business information is kept as placeholders — links [链接], emails [邮箱], mentions [@用户],
phone / QQ / WeChat numbers [联系方式] (the keyword before a number is kept); #topic# keeps its words. eval_clean removes
dataset artifacts only some sources carry (HTML entities, traditional script, reply / repost wrappers, emoji codes,
unicode emoji) and is applied before model_view when building the eval set; the runtime does not need it.
"""
import html
import re

VERSION = "mv-1"

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_URL = re.compile(r"(?:https?://|www\.)[^\s一-鿿]+|(?<![A-Za-z0-9.@-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|cn|net|org|top|xyz|cc|io|me|info)\b(?:/[^\s一-鿿]*)?", re.I)
_PHONE = re.compile(r"(?<!\d)1[3-9]\d(?:[- ]?\d{4}){2}(?!\d)")
_LANDLINE = re.compile(r"(?<!\d)0\d{2,3}-\d{7,8}(?!\d)")
_QQ = re.compile(r"((?:QQ|qq|扣扣|企鹅)号?[\s:：]*)\d{5,11}(?!\d)")
_WECHAT = re.compile(r"((?:微信|v信|V信|vx|VX|wx|WX|威信|薇信)号?[\s:：]*)[A-Za-z][-_A-Za-z0-9]{5,19}(?![-_A-Za-z0-9])")
_MENTION = re.compile(r"(?<![A-Za-z0-9._-])@[^\s@:：，。！？,.!?]{1,20}(?=[:：\s]|$)")
_HASHTAG = re.compile(r"#([^#\n]{1,30})#")
_WS = re.compile(r"\s+")

_REPLY = re.compile(r"^\s*回复\s*@[^:：\s@，。！？,.!?]{1,20}[:：\s]")
_REPOST = re.compile(r"//\s*@[^:：\s@，。！？,.!?]{1,20}(?:[:：]|\s|$)")
_EMOJI_CODE = re.compile(r"\[[一-龥a-zA-Z]{1,6}\]")
_UNICODE_EMOJI = re.compile(r"[\U0001F000-\U0001FAFF☀-➿️‍]")


def model_view(t: str) -> str:
    t = _EMAIL.sub("[邮箱]", t)
    t = _URL.sub("[链接]", t)
    t = _PHONE.sub("[联系方式]", t)
    t = _LANDLINE.sub("[联系方式]", t)
    t = _QQ.sub(lambda m: m.group(1) + "[联系方式]", t)
    t = _WECHAT.sub(lambda m: m.group(1) + "[联系方式]", t)
    t = _MENTION.sub("[@用户]", t)
    t = _HASHTAG.sub(r"\1", t)
    return _WS.sub(" ", t).strip()


def eval_clean(t: str) -> str:
    from zhconv import convert
    t = convert(html.unescape(str(t)), "zh-cn")
    t = _REPLY.sub("", t)
    t = _REPOST.sub(" ", t)
    t = _EMOJI_CODE.sub("", t)
    return _UNICODE_EMOJI.sub("", t)
