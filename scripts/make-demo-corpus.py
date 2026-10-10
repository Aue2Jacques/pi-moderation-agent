"""Demo corpus: real test-split texts with the real Kev scores they got, for the console's demo traffic (DEMO_CORPUS).

Joins the test split (data/eval/eval20k.jsonl) with one judge's raw answers on it (data/eval/test-v1-<run>/answers-
text.jsonl, scripts/eval-test.ts) and writes one line per item: id, kind (from the slice), the masked text and the
judge's primary / copy distributions. The text is the model view (links, emails, mentions, phone / QQ / WeChat numbers
as placeholders, python/eval/model_view.py) with every remaining run of 6+ digits replaced too, so the console never
shows a contact. The output stays on the servers (data/ is not committed); nothing is printed but counts.
usage: python3 scripts/make-demo-corpus.py data/eval/eval20k.jsonl data/eval/test-v1-kev4b-v1/answers-text.jsonl out.jsonl
"""

import json, re, sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
from eval.model_view import model_view  # noqa: E402

DIGITS = re.compile(r"\d(?:[\s-]?\d){5,}")


def kind_of(slice_: str) -> str:
    top = slice_.split("/")[0]
    if top in ("abuse", "adversarial"): return "abuse"
    if top == "marketing": return "marketing"
    if top == "injection": return "injection"
    return "normal"


def mask(text: str) -> str:
    return DIGITS.sub("[联系方式]", model_view(text))


def main(eval_path: str, answers_path: str, out_path: str) -> None:
    answers = {}
    for line in open(answers_path, encoding="utf-8"):
        a = json.loads(line)
        if a.get("ok") and a.get("view") == "text": answers[a["id"]] = a
    kinds, skipped = Counter(), 0
    with open(out_path, "w", encoding="utf-8") as out:
        for line in open(eval_path, encoding="utf-8"):
            r = json.loads(line)
            a = answers.get(r["id"])
            text = mask(r["text"])
            if a is None or not text or len(text) > 300: skipped += 1; continue
            k = kind_of(r["slice"])
            kinds[k] += 1
            out.write(json.dumps({"id": r["id"], "kind": k, "slice": r["slice"], "text": text, "model": a["model"],
                                  "primary": a["primary"], "copy": a.get("copy") or {}}, ensure_ascii=False) + "\n")
    print(json.dumps({"written": sum(kinds.values()), "skipped": skipped, "kinds": kinds}))


if __name__ == "__main__":
    main(*sys.argv[1:4])
