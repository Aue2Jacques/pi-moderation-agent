"""Does kev's training encoding of a rules-first / short-question record give exactly the tokens kevfast feeds at serving
time (KF_LAYOUT=rules_first, KF_QUESTIONS=short)? Compares the state (prefix + content) and every branch.
usage (kev venv): python -m kevfast.check_tokens <records.jsonl> [n=300]"""
import json, sys
from kev.model import load_tokenizer, encode, rows_of, SPECIAL, user_tokens
from kev.api import SystemOneRequest, to_record
from kevfast.common import to_engine_request
tok = load_tokenizer("Qwen/Qwen3.5-4B-Base")
S0 = tok.convert_tokens_to_ids(SPECIAL[0]); q_id, o_id, c_id, d_id = (tok.convert_tokens_to_ids(t) for t in SPECIAL[1:])
bad_state = bad_branch = n = 0; lens = []
path, N = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 300
for l, _ in zip(open(path), range(N)):
    r = json.loads(l)
    req = SystemOneRequest(state=r["state"], questions={k: {kk: vv for kk, vv in q.items() if kk != "label"} for k, q in r["questions"].items()})
    rec, meta = to_record(req)
    enc = encode(tok, rec, max_state=4096)
    S, _, rows = rows_of(enc)
    er = to_engine_request(r["state"], {k: {kk: vv for kk, vv in q.items() if kk != "label"} for k, q in r["questions"].items()}, "rules_first", True)[0]
    mine_state = [S0] + user_tokens(tok, er["prefix"] + "\n") + user_tokens(tok, er["content"])
    bad_state += mine_state != S; n += 1; lens.append(len(S))
    for q, row in zip(er["questions"], rows):
        b = [q_id] + user_tokens(tok, q["key"])
        for o in q["names"]: b += [o_id] + user_tokens(tok, o) + [c_id]
        b += [d_id]
        bad_branch += b != row["ids"]
lens.sort()
print(json.dumps({"records": n, "state_mismatch": bad_state, "branch_mismatch": bad_branch, "state_tokens_p50": lens[len(lens)//2], "p99": lens[int(len(lens)*.99)], "max": lens[-1]}))
