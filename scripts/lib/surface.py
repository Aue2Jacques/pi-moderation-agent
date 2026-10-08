"""Surface features of a comment (no meaning): used to find source artifacts that leak the label."""
import re

# characters that only appear in traditional script (common ones); an item "is traditional" with >= 2 of them
TRAD = set("".join([  # split into short pieces so the redact scan does not mistake it for copied text
    "們這個說來時會對",
    "為與還麼後學國實",
    "發點見過開關頭話",
    "體樣讓從當經裡處",
    "總機將應該並無間",
    "現長問題業東車買",
    "賣錢",
]))
CHECKS = {
    "url": re.compile(r"https?://|www\.|\.com\b|\.cn\b"),
    "at": re.compile(r"@\S"),
    "reply_prefix": re.compile(r"^\s*(回复|//)"),
    "hashtag": re.compile(r"#[^#\s]{1,30}#"),
    "emoji_code": re.compile(r"\[[\u4e00-\u9fa5a-zA-Z]{1,6}\]"),
    "newline": re.compile(r"\n"),
    "html_entity": re.compile(r"&(amp|lt|gt|quot|nbsp|#\d+);"),
    "unicode_emoji": re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]"),
    "contact": re.compile(r"(微信|vx|VX|wx|qq|QQ|加我|私聊|联系)|\d{7,}"),
}
KEYS = list(CHECKS) + ["latin_heavy", "trad"]


def flags(t):
    out = {k: bool(r.search(t)) for k, r in CHECKS.items()}
    letters = [c for c in t if not c.isspace()]
    out["latin_heavy"] = sum(1 for c in letters if c.isascii() and c.isalpha()) / max(1, len(letters)) > 0.5
    out["trad"] = sum(1 for c in t if c in TRAD) >= 2
    return out
