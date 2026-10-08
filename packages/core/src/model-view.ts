// Model view (dev plan E5): the text a judge sees. Same rules as python/eval/model_view.py; both must pass
// rules/model-view-cases.json. The stored content text stays the source of truth (the agent's tools read it); only the
// judge request carries this view. Business information is kept as placeholders — links [链接], emails [邮箱],
// mentions [@用户], phone / QQ / WeChat numbers [联系方式] (the keyword before a number is kept); #topic# keeps its words.
export const MODEL_VIEW_VERSION = "mv-1";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s一-鿿]+|(?<![A-Za-z0-9.@-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|cn|net|org|top|xyz|cc|io|me|info)\b(?:\/[^\s一-鿿]*)?/gi;
const PHONE = /(?<!\d)1[3-9]\d(?:[- ]?\d{4}){2}(?!\d)/g;
const LANDLINE = /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g;
const QQ = /((?:QQ|qq|扣扣|企鹅)号?[\s:：]*)\d{5,11}(?!\d)/g;
const WECHAT = /((?:微信|v信|V信|vx|VX|wx|WX|威信|薇信)号?[\s:：]*)[A-Za-z][-_A-Za-z0-9]{5,19}(?![-_A-Za-z0-9])/g;
const MENTION = /(?<![A-Za-z0-9._-])@[^\s@:：，。！？,.!?]{1,20}(?=[:：\s]|$)/g;
const HASHTAG = /#([^#\n]{1,30})#/g;

export function modelView(text: string): string {
  return text
    .replace(EMAIL, "[邮箱]")
    .replace(URL_RE, "[链接]")
    .replace(PHONE, "[联系方式]")
    .replace(LANDLINE, "[联系方式]")
    .replace(QQ, "$1[联系方式]")
    .replace(WECHAT, "$1[联系方式]")
    .replace(MENTION, "[@用户]")
    .replace(HASHTAG, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
