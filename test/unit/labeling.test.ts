// Label tables of the platform labeling standards (scripts/lib/labeling.ts): the label is computed from the fact
// answers, "不确定" is kept as uncertain, and the abuse exemption needs every hit to be a quotation or negation.
import { describe, expect, it } from "vitest";
import { ABUSE_V4, ABUSE_V41, ABUSE_V42, GUARD_V1, MARKETING_V1, followUpFor, majority, parseAnswers, readAnswers, type Answer } from "../../scripts/lib/labeling.ts";

const abuse = (over: Partial<Record<string, Answer>>) => ABUSE_V4.label({ q1: "否", q2: "否", q3: "否", q4: "否", q5: "否", q6: "否", q7: "否", ...over } as Record<string, Answer>);
const mkt = (over: Partial<Record<string, Answer>>) => MARKETING_V1.label({ m1: "否", m2: "否", m3: "否", m4: "否", ...over } as Record<string, Answer>);

describe("abuse-v4 label table", () => {
  it("no hit, no doubt -> allow", () => expect(abuse({})).toBe("allow"));
  it("a hit without exemption -> violate", () => expect(abuse({ q3: "是" })).toBe("violate"));
  it("every hit quoted to refute (q7 是) -> allow", () => expect(abuse({ q1: "是", q7: "是" })).toBe("allow"));
  it("q7 不确定 on a hit -> uncertain, not allow", () => expect(abuse({ q2: "是", q7: "不确定" })).toBe("uncertain"));
  it("no hit but a 不确定 -> uncertain", () => expect(abuse({ q5: "不确定" })).toBe("uncertain"));
  it("q7 是 without any hit does not matter -> allow", () => expect(abuse({ q7: "是" })).toBe("allow"));
  it("a hit beats another question's 不确定", () => expect(abuse({ q1: "是", q4: "不确定" })).toBe("violate"));
});

describe("marketing-v1 label table", () => {
  it("contact / off-site lead -> violate", () => expect(mkt({ m1: "是", m4: "是" })).toBe("violate"));
  it("black market -> violate", () => expect(mkt({ m3: "是" })).toBe("violate"));
  it("selling, not a natural share -> violate", () => expect(mkt({ m2: "是" })).toBe("violate"));
  it("selling AND natural share contradict -> uncertain", () => expect(mkt({ m2: "是", m4: "是" })).toBe("uncertain"));
  it("natural share alone -> allow", () => expect(mkt({ m4: "是" })).toBe("allow"));
  it("doubt on a deciding question -> uncertain", () => expect(mkt({ m1: "不确定" })).toBe("uncertain"));
  it("doubt only on m4 -> allow", () => expect(mkt({ m4: "不确定" })).toBe("allow"));
});

describe("guard-v1 label table", () => {
  it("maps g1 directly", () => {
    expect(GUARD_V1.label({ g1: "是" })).toBe("violate");
    expect(GUARD_V1.label({ g1: "否" })).toBe("allow");
    expect(GUARD_V1.label({ g1: "不确定" })).toBe("uncertain");
  });
});

describe("parseAnswers", () => {
  it("reads a JSON object wrapped in text", () => expect(parseAnswers(GUARD_V1, '好的\n```json\n{"g1":"否"}\n```')).toEqual({ g1: "否" }));
  it("rejects a missing question", () => expect(parseAnswers(MARKETING_V1, '{"m1":"否","m2":"否","m3":"否"}')).toBeUndefined());
  it("rejects an answer outside 是/否/不确定", () => expect(parseAnswers(GUARD_V1, '{"g1":"可能"}')).toBeUndefined());
  it("rejects broken JSON", () => expect(parseAnswers(GUARD_V1, '{"g1":"否"')).toBeUndefined());
});

describe("prompts", () => {
  it("every standard's prompt has the text slot and names each question", () => {
    for (const s of [ABUSE_V4, ABUSE_V41, ABUSE_V42, MARKETING_V1, GUARD_V1]) {
      expect(s.prompt).toContain("{{TEXT}}");
      for (const q of s.questions) expect(s.prompt).toContain(q);
    }
  });
});

describe("abuse-v4.1", () => {
  it("is a new prompt version with the v4 label table", () => {
    expect(ABUSE_V41.promptSha).not.toBe(ABUSE_V4.promptSha);
    expect(new Set([ABUSE_V4, ABUSE_V41, ABUSE_V42].map((s) => s.promptSha)).size).toBe(3);
    expect(ABUSE_V41.label({ q1: "是", q2: "否", q3: "否", q4: "否", q5: "否", q6: "否", q7: "不确定" })).toBe("uncertain");
  });
});

describe("readAnswers / followUpFor", () => {
  it("lists the questions a model left out", () => {
    const r = readAnswers(ABUSE_V41, '{"q1":"是","q2":"否","q3":"否","q4":"否","q5":"否","q6":"否","reason":"x"}');
    expect(r?.missing).toEqual(["q7"]);
    expect(r?.got.q1).toBe("是");
  });
  it("still rejects an invalid answer", () => expect(readAnswers(ABUSE_V41, '{"q1":"maybe"}')).toBeUndefined());
  it("asks only for the missing keys", () => expect(followUpFor(["q7"])).toContain('{"q7":"是|否|不确定"}'));
});

describe("majority", () => {
  it("2 of 3 wins", () => expect(majority(["violate", "allow", "violate"])).toBe("violate"));
  it("three different labels -> uncertain", () => expect(majority(["violate", "allow", "uncertain"])).toBe("uncertain"));
  it("a tie on an even count -> uncertain", () => expect(majority(["violate", "allow"])).toBe("uncertain"));
});
