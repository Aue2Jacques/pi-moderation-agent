"""kevfast: a packed, switchable inference engine for Kev checkpoints on the hybrid Qwen3.5 backbone (owner 2026-10-09:
"把优化到极致的情况先封装好……把每一个优化的功能封装成一个可以开关的选项").

Kev's own serving runs every request as [state] + one row per question; every row carries the whole rule text, and rows
are padded to a common length. This engine runs the same checkpoint as a three-level tree of token segments, packed into
one sequence per pass (no padding):

  prefix   (optional, cached across requests)  the rules block, when the request puts it first
  content  one segment per request, continuing the prefix (or starting fresh)
  branch   one segment per question, continuing its request's content

DeltaNet layers carry each parent's final recurrent / conv state into its children (fla kernels with cu_seqlens and
per-sequence initial states); attention layers see the parent chain's keys and values through a block mask. Branches
never see each other, as in Kev. With layout=native and questions=full the engine computes exactly Kev's rows
(test_engine.py checks the probabilities against kev's own path).

Switches (Options, or KF_* environment variables for serve.py):
  layout     native | rules_first   rules_first: a state that starts with a "rules" field is split; the rules are the cached
                                    prefix and only the rest is computed per request
  questions  full | short           short: a branch is the rule key and short option labels; the rule text lives only in the prefix
  confirm    on | off               off: drop the shuffled-option copies ("<key>#confirm") before computing
  fp8        off | on | auto        FP8 (e4m3) GEMMs, per-row weight / per-token activation scales; auto: only for passes of
                                    at least fp8_min_tokens tokens (small passes lose to the quantisation overhead)
  max_batch  requests per model pass (serve.py)
Checkpoints are trained on one layout; switching layout / questions / confirm changes what the model reads, so answers are
only meaningful for a checkpoint trained the same way. fp8 changes rounding only.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, replace

import torch
import torch.nn.functional as F

LAYOUTS, QUESTIONS, FP8_MODES = ("native", "rules_first"), ("full", "short"), ("off", "on", "auto")
SHORT_LABELS = {"violate": "违规", "none": "不违规", "unknown": "无法判断"}


@dataclass(frozen=True)
class Options:
    layout: str = "native"
    questions: str = "full"
    confirm: bool = True
    fp8: str = "off"
    fp8_min_tokens: int = 512
    max_batch: int = 32

    def __post_init__(self):
        if self.layout not in LAYOUTS: raise ValueError(f"layout {self.layout!r} not in {LAYOUTS}")
        if self.questions not in QUESTIONS: raise ValueError(f"questions {self.questions!r} not in {QUESTIONS}")
        if self.fp8 not in FP8_MODES: raise ValueError(f"fp8 {self.fp8!r} not in {FP8_MODES}")

    @staticmethod
    def from_env(env=os.environ) -> "Options":
        o = Options()
        return replace(o, layout=env.get("KF_LAYOUT", o.layout), questions=env.get("KF_QUESTIONS", o.questions),
                       confirm=env.get("KF_CONFIRM", "on") != "off", fp8=env.get("KF_FP8", o.fp8),
                       fp8_min_tokens=int(env.get("KF_FP8_MIN_TOKENS", o.fp8_min_tokens)), max_batch=int(env.get("KF_MAX_BATCH", o.max_batch)))

    def describe(self) -> dict:
        return {"layout": self.layout, "questions": self.questions, "confirm": self.confirm, "fp8": self.fp8,
                "fp8_min_tokens": self.fp8_min_tokens, "max_batch": self.max_batch}


# ---------------------------------------------------------------- linear layers (bf16 / FP8)
class Lin:
    """One projection: bf16 weight and/or an FP8 copy. mode off keeps bf16 only, on keeps FP8 only (the bf16 weight is
    freed), auto keeps both and picks per pass by token count."""

    def __init__(self, w: torch.Tensor, mode: str, min_tokens: int):
        self.mode, self.min_tokens = mode, min_tokens
        self.w = w if mode in ("off", "auto") else None
        self.w8 = self.sw = None
        if mode in ("on", "auto"):
            s = (w.float().abs().amax(1, keepdim=True) / 448).clamp(min=1e-12)
            self.w8, self.sw = (w.float() / s).to(torch.float8_e4m3fn), s.t().contiguous()

    def __call__(self, x: torch.Tensor) -> torch.Tensor:
        if self.w8 is None or (self.mode == "auto" and x.shape[0] < self.min_tokens):
            return F.linear(x, self.w)
        M = x.shape[0]; pad = (-M) % 16
        if pad: x = F.pad(x, (0, 0, 0, pad))
        sa = (x.abs().amax(1, keepdim=True).float() / 448).clamp(min=1e-12)
        y = torch._scaled_mm((x * (1 / sa).to(x.dtype)).to(torch.float8_e4m3fn), self.w8.t(), scale_a=sa, scale_b=self.sw, out_dtype=torch.bfloat16)
        return y[:M] if pad else y


# ---------------------------------------------------------------- packed segments
@dataclass
class Level:
    """One pass: segments packed back to back. parent[i] indexes the previous level's segments (None: no parent)."""
    ids: list[list[int]]
    pos: list[list[int]]
    parent: list[int] | None = None


@dataclass
class LevelOut:
    hidden: torch.Tensor                  # [T, d] after the final norm, fp32
    cu: list[int]                         # segment offsets into hidden
    conv: list                            # per layer: final conv state per segment [N, ...] (DeltaNet layers, else None)
    rec: list                             # per layer: final recurrent state per segment [N, H, K, V]
    k: list                               # per layer: this level's keys [Hkv, T, hd] (attention layers, else None)
    v: list
    ctx_kv: tuple | None                  # (keys, values) per layer of the ancestors this level read, or None
    ranges: list                          # per segment: the ranges of ctx_kv it read (its ancestors)

    @property
    def ctx_len(self) -> int:
        return 0 if self.ctx_kv is None else next(t.shape[1] for t in self.ctx_kv[0] if t is not None)


class Engine:
    def __init__(self, tok, model, opts: Options):
        """model: a kev DecisionModel loaded with fused=True (kev.fused_qwen35), bf16, on CUDA."""
        self.tok, self.model, self.opts = tok, model, opts
        self.lm = model.lm
        from kev.model import SPECIAL
        self.state_id = tok.convert_tokens_to_ids(SPECIAL[0])
        self.q_id, self.o_id, self.c_id, self.d_id = (tok.convert_tokens_to_ids(t) for t in SPECIAL[1:])
        self.layers = []
        with torch.no_grad():
            for layer in self.lm.layers:
                if not hasattr(layer, "input_norm_weight"):
                    raise ValueError("kevfast needs the checkpoint loaded with kev's fused kernels (LoadOptions(fused=True))")
                mix = layer.linear_attn if layer.block_type == "linear_attention" else layer.self_attn
                L = {"type": layer.block_type, "layer": layer, "mix": mix,
                     "in": Lin(mix.in_proj if layer.block_type == "linear_attention" else mix.qkv, opts.fp8, opts.fp8_min_tokens),
                     "out": Lin((mix.out_proj if layer.block_type == "linear_attention" else mix.o_proj).weight, opts.fp8, opts.fp8_min_tokens),
                     "gate_up": Lin(layer.mlp.gate_up, opts.fp8, opts.fp8_min_tokens),
                     "down": Lin(layer.mlp.down_proj.weight, opts.fp8, opts.fp8_min_tokens)}
                self.layers.append(L)
            if opts.fp8 == "on":   # the FP8 copies replace the bf16 weights
                for L in self.layers:
                    mix, layer = L["mix"], L["layer"]
                    if L["type"] == "linear_attention": mix.in_proj = None; mix.out_proj = None
                    else: mix.qkv = None; mix.o_proj = None
                    layer.mlp.gate_up = None; layer.mlp.down_proj = None
                torch.cuda.empty_cache()
        self.prefix_cache: dict[tuple, LevelOut] = {}

    # ------------------------------------------------------------ one packed pass
    @torch.no_grad()
    def run(self, level: Level, parent: LevelOut | None, want_state: bool) -> LevelOut:
        from fla.modules.activations import sigmoidglu, swiglu
        from fla.modules.conv import causal_conv1d
        from fla.modules.fused_norm_gate import rms_norm_gated
        from fla.modules.layernorm import rms_norm
        from fla.ops.gated_delta_rule import chunk_gated_delta_rule
        from transformers.models.qwen3_5.modeling_qwen3_5 import apply_rotary_pos_emb

        dev = self.model.device
        lens = [len(s) for s in level.ids]
        cu = [0]
        for n in lens: cu.append(cu[-1] + n)
        T, N = cu[-1], len(lens)
        ids = torch.tensor([t for s in level.ids for t in s], device=dev)
        pos = torch.tensor([p for s in level.pos for p in s], device=dev)
        cu_t = torch.tensor(cu, device=dev, dtype=torch.long)
        seg = torch.repeat_interleave(torch.arange(N, device=dev), torch.tensor(lens, device=dev))
        par = None if parent is None else torch.tensor(level.parent, device=dev)

        x = self.lm.embed_tokens(ids)                                     # [T, d]
        cos, sin = self.lm.rotary_emb(x[None], pos[None, None].expand(3, 1, T))

        # attention context: the parent's own keys appended to the parent's context; a segment reads its parent's
        # ancestors plus its parent (block mask), and itself causally
        ctx_k = ctx_v = None; ranges = [[] for _ in range(N)]; C = 0
        if parent is not None:
            Cp = parent.ctx_len
            ctx_k, ctx_v = [], []
            for li, L in enumerate(self.layers):
                if L["type"] == "linear_attention": ctx_k.append(None); ctx_v.append(None); continue
                ctx_k.append(parent.k[li] if parent.ctx_kv is None else torch.cat([parent.ctx_kv[0][li], parent.k[li]], 1))
                ctx_v.append(parent.v[li] if parent.ctx_kv is None else torch.cat([parent.ctx_kv[1][li], parent.v[li]], 1))
            ranges = [parent.ranges[p] + [(Cp + parent.cu[p], Cp + parent.cu[p + 1])] for p in level.parent]
            C = Cp + parent.cu[-1]
        # per-segment attention batch: each segment gathers only the keys it may read (its ancestor ranges, then itself),
        # so memory grows with the segments' own lengths, not with (all tokens)^2
        Lmax = max(lens)
        kidx = [[j for lo, hi in rs for j in range(lo, hi)] + list(range(C + cu[i], C + cu[i + 1])) for i, rs in enumerate(ranges)]
        Kmax = max(len(k) for k in kidx)
        qi = torch.zeros(N, Lmax, dtype=torch.long); qv = torch.zeros(N, Lmax, dtype=torch.bool)
        ki = torch.zeros(N, Kmax, dtype=torch.long); kv_ = torch.zeros(N, Kmax, dtype=torch.bool)
        own0 = torch.zeros(N, dtype=torch.long)
        for i in range(N):
            qi[i, :lens[i]] = torch.arange(cu[i], cu[i + 1]); qv[i, :lens[i]] = True
            ki[i, :len(kidx[i])] = torch.tensor(kidx[i]); kv_[i, :len(kidx[i])] = True
            own0[i] = len(kidx[i]) - lens[i]                       # where the segment's own keys start in its key list
        qi, qv, ki, kv_, own0 = (t.to(dev) for t in (qi, qv, ki, kv_, own0))
        kpos = torch.arange(Kmax, device=dev)[None, None, :]; qpos = torch.arange(Lmax, device=dev)[None, :, None]
        allow = kv_[:, None, :] & ((kpos < own0[:, None, None]) | (kpos - own0[:, None, None] <= qpos))   # ancestors, or own and causal
        allow &= qv[:, :, None]
        allow |= ~qv[:, :, None]                                    # padded query rows: anything (discarded), avoids NaN
        mask = allow[:, None]                                       # [N, 1, Lmax, Kmax]

        conv_out, rec_out, k_out, v_out = [], [], [], []
        for li, L in enumerate(self.layers):
            layer, mix = L["layer"], L["mix"]
            h = rms_norm(x, layer.input_norm_weight, None, eps=layer.input_layernorm.eps)
            if L["type"] == "linear_attention":
                mixed, z, b, a = L["in"](h).split(mix.splits, -1)
                ci = None if parent is None else parent.conv[li].index_select(0, par)
                ri = None if parent is None else parent.rec[li].index_select(0, par)
                mixed, conv_state = causal_conv1d(mixed[None], mix.conv_weight, None, initial_state=ci, output_final_state=want_state,
                                                  activation="silu", cu_seqlens=cu_t)
                q, k, v = mixed.split([mix.key_dim, mix.key_dim, mix.value_dim], -1)
                o, rec = chunk_gated_delta_rule(q.reshape(1, T, -1, mix.head_k_dim), k.reshape(1, T, -1, mix.head_k_dim), v.reshape(1, T, -1, mix.head_v_dim),
                                                g=a[None], beta=b[None], initial_state=ri, output_final_state=want_state, cu_seqlens=cu_t,
                                                use_qk_l2norm_in_kernel=True, use_gate_in_kernel=True, A_log=mix.A_log, dt_bias=mix.dt_bias,
                                                use_beta_sigmoid_in_kernel=True)
                o = rms_norm_gated(o, z.reshape(1, T, -1, mix.head_v_dim), mix.norm.weight, None, activation="swish", eps=mix.norm.variance_epsilon)
                h = L["out"](o.reshape(T, -1))
                conv_out.append(conv_state if want_state else None); rec_out.append(rec if want_state else None); k_out.append(None); v_out.append(None)
            else:
                q_gate, k, v = L["in"](h).split(mix.splits, -1)
                hd = mix.head_dim
                q, gate = q_gate.reshape(T, -1, 2 * hd).chunk(2, -1)
                q = rms_norm(q, mix.q_norm_weight, None, eps=mix.q_norm.eps).transpose(0, 1)[None]           # [1, Hq, T, hd]
                k = rms_norm(k.reshape(T, -1, hd), mix.k_norm_weight, None, eps=mix.k_norm.eps).transpose(0, 1)[None]
                q, k = apply_rotary_pos_emb(q, k, cos, sin)
                v = v.reshape(T, -1, hd).transpose(0, 1)[None]
                K, V = (k[0], v[0]) if ctx_k is None else (torch.cat([ctx_k[li], k[0]], 1), torch.cat([ctx_v[li], v[0]], 1))   # [Hkv, C+T, hd]
                qb = q[0][:, qi].transpose(0, 1)                                          # [N, Hq, Lmax, hd]
                Kb, Vb = K[:, ki].transpose(0, 1), V[:, ki].transpose(0, 1)               # [N, Hkv, Kmax, hd]
                ob = F.scaled_dot_product_attention(qb, Kb.to(qb.dtype), Vb.to(qb.dtype), attn_mask=mask, scale=mix.scaling, enable_gqa=True)
                o = ob.transpose(1, 2)[qv]                                                # [T, Hq, hd] in packed order
                o = o.reshape(T, -1)
                h = L["out"](sigmoidglu(gate.reshape(T, -1), o))
                conv_out.append(None); rec_out.append(None); k_out.append(k[0]); v_out.append(v[0])
            h, residual = rms_norm(h, layer.post_norm_weight, None, residual=x, eps=layer.post_attention_layernorm.eps, prenorm=True)
            gate_up = L["gate_up"](h)
            x = residual + L["down"](swiglu(*gate_up.chunk(2, -1)))
        hidden = self.lm.norm(x).float()
        return LevelOut(hidden, cu, conv_out, rec_out, k_out, v_out, None if ctx_k is None else (ctx_k, ctx_v), ranges)

    # ------------------------------------------------------------ requests
    def prefix(self, text: str) -> LevelOut:
        """The rules block as a cached root segment: [<state>] + rules text + newline."""
        from kev.model import user_tokens
        key = (text,)
        if key not in self.prefix_cache:
            ids = [self.state_id] + user_tokens(self.tok, text + "\n")
            out = self.run(Level([ids], [list(range(len(ids)))]), None, want_state=True)
            if len(self.prefix_cache) > 8: self.prefix_cache.pop(next(iter(self.prefix_cache)))
            self.prefix_cache[key] = out
        return self.prefix_cache[key]

    def branch_tokens(self, q: dict) -> list[int]:
        """[<q> instr <opt> o </opt>... <decide>] as kev.model.encode builds it; short: instr = the rule key, options = short labels."""
        from kev.model import user_tokens
        instr = q["key"] if self.opts.questions == "short" else q["instr"]
        opts = [SHORT_LABELS.get(n, n) for n in q["names"]] if self.opts.questions == "short" else q["options"]
        b = [self.q_id] + user_tokens(self.tok, instr)
        for o in opts: b += [self.o_id] + user_tokens(self.tok, o) + [self.c_id]
        return b + [self.d_id]

    @torch.no_grad()
    def answer(self, reqs: list[dict]) -> list[list[torch.Tensor]]:
        """reqs: {"prefix": rules text or None, "content": rendered state text, "questions": [{"key", "instr", "options", "names"}]}.
        All requests in one call must share the prefix (serve.py groups them). -> per request, per question, probabilities."""
        from kev.model import user_tokens
        pre = reqs[0]["prefix"]
        if any(r["prefix"] != pre for r in reqs): raise ValueError("one call, one prefix")
        root = self.prefix(pre) if pre is not None else None
        P = 0 if root is None else root.cu[-1]
        c_ids, c_pos = [], []
        for r in reqs:
            ids = user_tokens(self.tok, r["content"]) if root is not None else [self.state_id] + user_tokens(self.tok, r["content"])
            c_ids.append(ids); c_pos.append(list(range(P, P + len(ids))))
        content = self.run(Level(c_ids, c_pos, [0] * len(reqs) if root is not None else None), root, want_state=True)
        b_ids, b_pos, b_par, picks, ks = [], [], [], [], []
        for i, r in enumerate(reqs):
            start = P + len(c_ids[i])
            for q in r["questions"]:
                b = self.branch_tokens(q)
                b_ids.append(b); b_pos.append(list(range(start, start + len(b)))); b_par.append(i)
                opt_ends = [j for j, t in enumerate(b) if t == self.c_id]
                picks.append((len(b) - 1, opt_ends)); ks.append(len(opt_ends))
        branches = self.run(Level(b_ids, b_pos, b_par), content, want_state=False)
        rows = []
        for s, (d, oe) in enumerate(picks):
            off = branches.cu[s]
            rows += [off + d] + [off + e for e in oe]
        X = branches.hidden[torch.tensor(rows, device=branches.hidden.device)]
        ps = list(self.model._readout_many(X, ks))
        out, it = [], iter(ps)
        for r in reqs: out.append([next(it) for _ in r["questions"]])
        return out
