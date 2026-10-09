"""kevfast: a packed, switchable inference engine for Kev checkpoints on the hybrid Qwen3.5 backbone (owner 2026-10-09:
package the fastest configuration first, with every optimisation as its own switch, so accuracy changes can be traced
to one switch later).

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
  max_batch  requests per model call (serve.py)
  branch_mode  two_pass: the comment runs once, then the question branches continue its saved state (fewest tokens);
               rows: one pass, each question a row = comment + branch (the comment is recomputed per question; fewer
               kernel launches); auto: rows when a call has at most rows_max_requests requests. Same answers either way.
  cuda_graphs  rows calls run right-padded (pads after a row's last token change nothing it reads) in length buckets of
               16 tokens, each (rows, bucket) captured once as a CUDA graph and replayed: no per-kernel launch cost
  max_pass_tokens  a call is split into groups of requests whose content + branch tokens fit this budget (16 GB card:
                   one pass of ~14k branch tokens ran out of memory)
Checkpoints are trained on one layout; switching layout / questions / confirm changes what the model reads, so answers are
only meaningful for a checkpoint trained the same way. fp8 changes rounding only.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, replace

import torch
import torch.nn.functional as F

LAYOUTS, QUESTIONS, FP8_MODES, BRANCH_MODES = ("native", "rules_first"), ("full", "short"), ("off", "on", "auto"), ("two_pass", "rows", "auto")
SHORT_LABELS = {"violate": "违规", "none": "不违规", "unknown": "无法判断"}
SDPA_GATHER_BYTES = 1 << 30   # per attention layer: gather the shared prefix per segment (fused SDPA) up to this size


@dataclass(frozen=True)
class Options:
    layout: str = "native"
    questions: str = "full"
    confirm: bool = True
    fp8: str = "off"
    fp8_min_tokens: int = 512
    max_batch: int = 32
    max_pass_tokens: int = 6144
    branch_mode: str = "auto"          # two_pass | rows | auto
    rows_max_requests: int = 4
    cuda_graphs: bool = True           # rows calls: right-padded to a length bucket and replayed from a captured graph
    graph_max_tokens: int = 1024       # only rows calls up to this many padded tokens use graphs (memory: each graph keeps its buffers)

    def __post_init__(self):
        if self.layout not in LAYOUTS: raise ValueError(f"layout {self.layout!r} not in {LAYOUTS}")
        if self.questions not in QUESTIONS: raise ValueError(f"questions {self.questions!r} not in {QUESTIONS}")
        if self.fp8 not in FP8_MODES: raise ValueError(f"fp8 {self.fp8!r} not in {FP8_MODES}")
        if self.branch_mode not in BRANCH_MODES: raise ValueError(f"branch_mode {self.branch_mode!r} not in {BRANCH_MODES}")

    @staticmethod
    def from_env(env=os.environ) -> "Options":
        o = Options()
        return replace(o, layout=env.get("KF_LAYOUT", o.layout), questions=env.get("KF_QUESTIONS", o.questions),
                       confirm=env.get("KF_CONFIRM", "on") != "off", fp8=env.get("KF_FP8", o.fp8),
                       fp8_min_tokens=int(env.get("KF_FP8_MIN_TOKENS", o.fp8_min_tokens)), max_batch=int(env.get("KF_MAX_BATCH", o.max_batch)),
                       max_pass_tokens=int(env.get("KF_MAX_PASS_TOKENS", o.max_pass_tokens)), branch_mode=env.get("KF_BRANCH_MODE", o.branch_mode),
                       rows_max_requests=int(env.get("KF_ROWS_MAX_REQUESTS", o.rows_max_requests)), cuda_graphs=env.get("KF_CUDA_GRAPHS", "on") != "off",
                       graph_max_tokens=int(env.get("KF_GRAPH_MAX_TOKENS", o.graph_max_tokens)))

    def describe(self) -> dict:
        return {"layout": self.layout, "questions": self.questions, "confirm": self.confirm, "fp8": self.fp8,
                "fp8_min_tokens": self.fp8_min_tokens, "max_batch": self.max_batch, "max_pass_tokens": self.max_pass_tokens,
                "branch_mode": self.branch_mode, "rows_max_requests": self.rows_max_requests, "cuda_graphs": self.cuda_graphs,
                "graph_max_tokens": self.graph_max_tokens}


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
        self.graphs: dict[tuple, dict] = {}
        self.graph_pool = None

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
        cu_cpu = torch.tensor(cu, dtype=torch.long)
        cu_t = cu_cpu.to(dev)   # fla also gets the CPU copy: without it every varlen kernel call syncs to read the offsets
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
        # Attention reads, per segment, its ancestors' keys then its own (causal). A range every segment reads (the cached
        # rules prefix) is attended once for all tokens ("shared"); the rest is gathered per segment ("own"), so memory
        # grows with the segments' own lengths. The two parts are merged with their log-sum-exp (exact softmax).
        shared, gathered = None, ranges
        if ranges[0] and all(rs and rs[0] == ranges[0][0] for rs in ranges):
            shared, gathered = ranges[0][0], [rs[1:] for rs in ranges]
        Lmax = max(lens)
        kidx = [[j for lo, hi in rs for j in range(lo, hi)] + list(range(C + cu[i], C + cu[i + 1])) for i, rs in enumerate(gathered)]
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
        allow |= ~qv[:, :, None]                                    # padded query rows: anything (discarded), avoids NaN
        neg = torch.zeros(allow.shape, device=dev).masked_fill_(~allow, float("-inf"))[:, None]   # [N, 1, Lmax, Kmax]

        def attend(q, K, V, scale):
            """q [Hq, T, hd]; K, V [Hkv, C+T, hd] (context then this level). -> [T, Hq*hd] (bf16). Fused SDPA per
            segment batch; the shared range is gathered too when the batch is small enough, else merged by log-sum-exp."""
            g = q.shape[0] // K.shape[0]
            qb = q[:, qi].transpose(0, 1)                                                 # [N, Hq, Lmax, hd]
            if shared is not None and N * (shared[1] - shared[0] + Kmax) * K.shape[0] * K.shape[2] * 2 * g <= SDPA_GATHER_BYTES:
                lo, hi = shared
                kidx_all = torch.cat([torch.arange(lo, hi, device=dev).expand(N, -1), ki], 1)
                Kb = K[:, kidx_all].transpose(0, 1).repeat_interleave(g, 1)              # [N, Hq, P+Kmax, hd]
                Vb = V[:, kidx_all].transpose(0, 1).repeat_interleave(g, 1)
                m = torch.cat([torch.ones(N, Lmax, hi - lo, dtype=torch.bool, device=dev), allow], 2)[:, None]
                ob = F.scaled_dot_product_attention(qb, Kb, Vb, attn_mask=m, scale=scale)
                return ob.transpose(1, 2)[qv].reshape(q.shape[1], -1)
            Kb = K[:, ki].transpose(0, 1).repeat_interleave(g, 1)
            Vb = V[:, ki].transpose(0, 1).repeat_interleave(g, 1)
            if shared is None:
                ob = F.scaled_dot_product_attention(qb, Kb, Vb, attn_mask=allow[:, None], scale=scale)
                return ob.transpose(1, 2)[qv].reshape(q.shape[1], -1)
            qf = q.float() * scale                                                        # large batch: exact LSE merge
            sB = qb.float() * scale @ Kb.float().transpose(-1, -2) + neg
            mB = sB.amax(-1, keepdim=True); eB = (sB - mB).exp()
            lB, oB = eB.sum(-1, keepdim=True), eB @ Vb.float()
            unpack = lambda t: t.transpose(1, 2)[qv].transpose(0, 1)                      # -> [Hq, T, *]
            mB, lB, oB = unpack(mB), unpack(lB), unpack(oB)
            Ks = K[:, shared[0]:shared[1]].float().repeat_interleave(g, 0)
            Vs = V[:, shared[0]:shared[1]].float().repeat_interleave(g, 0)
            sA = qf @ Ks.transpose(-1, -2)
            mA = sA.amax(-1, keepdim=True); eA = (sA - mA).exp()
            lA, oA = eA.sum(-1, keepdim=True), eA @ Vs
            mm = torch.maximum(mA, mB); a_, b_ = (mA - mm).exp(), (mB - mm).exp()
            o = (oA * a_ + oB * b_) / (lA * a_ + lB * b_)
            return o.transpose(0, 1).reshape(q.shape[1], -1).to(torch.bfloat16)

        conv_out, rec_out, k_out, v_out = [], [], [], []
        for li, L in enumerate(self.layers):
            layer, mix = L["layer"], L["mix"]
            h = rms_norm(x, layer.input_norm_weight, None, eps=layer.input_layernorm.eps)
            if L["type"] == "linear_attention":
                mixed, z, b, a = L["in"](h).split(mix.splits, -1)
                ci = None if parent is None else parent.conv[li].index_select(0, par)
                ri = None if parent is None else parent.rec[li].index_select(0, par)
                mixed, conv_state = causal_conv1d(mixed[None], mix.conv_weight, None, initial_state=ci, output_final_state=want_state,
                                                  activation="silu", cu_seqlens=cu_t, cu_seqlens_cpu=cu_cpu)
                q, k, v = mixed.split([mix.key_dim, mix.key_dim, mix.value_dim], -1)
                o, rec = chunk_gated_delta_rule(q.reshape(1, T, -1, mix.head_k_dim), k.reshape(1, T, -1, mix.head_k_dim), v.reshape(1, T, -1, mix.head_v_dim),
                                                g=a[None], beta=b[None], initial_state=ri, output_final_state=want_state, cu_seqlens=cu_t, cu_seqlens_cpu=cu_cpu,
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
                o = attend(q[0], K, V, mix.scaling)
                h = L["out"](sigmoidglu(gate.reshape(T, -1), o))
                conv_out.append(None); rec_out.append(None); k_out.append(k[0]); v_out.append(v[0])
            h, residual = rms_norm(h, layer.post_norm_weight, None, residual=x, eps=layer.post_attention_layernorm.eps, prenorm=True)
            gate_up = L["gate_up"](h)
            x = residual + L["down"](swiglu(*gate_up.chunk(2, -1)))
        hidden = self.lm.norm(x).float()
        return LevelOut(hidden, cu, conv_out, rec_out, k_out, v_out, None if ctx_k is None else (ctx_k, ctx_v), ranges)

    # ------------------------------------------------------------ padded rows + CUDA graphs (small calls)
    @torch.no_grad()
    def run_padded(self, ids: torch.Tensor, pos: torch.Tensor, root: LevelOut | None) -> torch.Tensor:
        """ids, pos [R, Lb], rows right-padded; every row continues `root` (or starts fresh). -> hidden [R, Lb, d] fp32.
        GPU work only (capturable): no host copies, no data-dependent shapes."""
        from fla.modules.activations import sigmoidglu, swiglu
        from fla.modules.conv import causal_conv1d
        from fla.modules.fused_norm_gate import rms_norm_gated
        from fla.modules.layernorm import rms_norm
        from fla.ops.gated_delta_rule import chunk_gated_delta_rule
        from transformers.models.qwen3_5.modeling_qwen3_5 import apply_rotary_pos_emb
        R, Lb = ids.shape
        x = self.lm.embed_tokens(ids)                                      # [R, Lb, d]
        cos, sin = self.lm.rotary_emb(x, pos[None].expand(3, R, Lb))
        P = 0 if root is None else root.cu[-1]
        own = torch.ones(Lb, Lb, dtype=torch.bool, device=ids.device).tril()
        mask = own if root is None else torch.cat([torch.ones(Lb, P, dtype=torch.bool, device=ids.device), own], 1)
        for li, L in enumerate(self.layers):
            layer, mix = L["layer"], L["mix"]
            h = rms_norm(x, layer.input_norm_weight, None, eps=layer.input_layernorm.eps)
            if L["type"] == "linear_attention":
                mixed, z, b, a = L["in"](h.reshape(R * Lb, -1)).reshape(R, Lb, -1).split(mix.splits, -1)
                ci = None if root is None else root.conv[li].expand(R, *root.conv[li].shape[1:]).contiguous()
                ri = None if root is None else root.rec[li].expand(R, *root.rec[li].shape[1:]).contiguous()
                mixed, _ = causal_conv1d(mixed, mix.conv_weight, None, initial_state=ci, output_final_state=False, activation="silu")
                q, k, v = mixed.split([mix.key_dim, mix.key_dim, mix.value_dim], -1)
                o, _ = chunk_gated_delta_rule(q.reshape(R, Lb, -1, mix.head_k_dim), k.reshape(R, Lb, -1, mix.head_k_dim), v.reshape(R, Lb, -1, mix.head_v_dim),
                                              g=a, beta=b, initial_state=ri, output_final_state=False,
                                              use_qk_l2norm_in_kernel=True, use_gate_in_kernel=True, A_log=mix.A_log, dt_bias=mix.dt_bias, use_beta_sigmoid_in_kernel=True)
                o = rms_norm_gated(o, z.reshape(R, Lb, -1, mix.head_v_dim), mix.norm.weight, None, activation="swish", eps=mix.norm.variance_epsilon)
                h = L["out"](o.reshape(R * Lb, -1)).reshape(R, Lb, -1)
            else:
                q_gate, k, v = L["in"](h.reshape(R * Lb, -1)).reshape(R, Lb, -1).split(mix.splits, -1)
                hd = mix.head_dim
                q, gate = q_gate.reshape(R, Lb, -1, 2 * hd).chunk(2, -1)
                q = rms_norm(q, mix.q_norm_weight, None, eps=mix.q_norm.eps).transpose(1, 2)           # [R, Hq, Lb, hd]
                k = rms_norm(k.reshape(R, Lb, -1, hd), mix.k_norm_weight, None, eps=mix.k_norm.eps).transpose(1, 2)
                q, k = apply_rotary_pos_emb(q, k, cos, sin)
                v = v.reshape(R, Lb, -1, hd).transpose(1, 2)
                if root is not None:
                    k = torch.cat([root.k[li][None].expand(R, -1, -1, -1), k], 2); v = torch.cat([root.v[li][None].expand(R, -1, -1, -1), v], 2)
                o = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, scale=mix.scaling, enable_gqa=True)
                h = L["out"](sigmoidglu(gate.reshape(R * Lb, -1), o.transpose(1, 2).reshape(R * Lb, -1))).reshape(R, Lb, -1)
            h, residual = rms_norm(h, layer.post_norm_weight, None, residual=x, eps=layer.post_attention_layernorm.eps, prenorm=True)
            gate_up = L["gate_up"](h.reshape(R * Lb, -1))
            x = residual + L["down"](swiglu(*gate_up.chunk(2, -1))).reshape(R, Lb, -1)
        return self.lm.norm(x).float()

    def rows_graph(self, b_ids, b_pos, root) -> torch.Tensor:
        """Run rows right-padded to a 16-token bucket, through a CUDA graph captured once per (rows, bucket, prefix)."""
        R, Lb = len(b_ids), -(-max(len(r) for r in b_ids) // 16) * 16
        key = (R, Lb, None if root is None else id(root))
        g = self.graphs.get(key)
        dev = self.model.device
        if g is None:
            g = {"ids": torch.full((R, Lb), self.tok.pad_token_id or 0, dtype=torch.long, device=dev), "pos": torch.zeros(R, Lb, dtype=torch.long, device=dev)}
            self._fill(g, b_ids, b_pos)
            s = torch.cuda.Stream(); s.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(s):
                for _ in range(2): self.run_padded(g["ids"], g["pos"], root)    # warm-up: triton autotune / compile outside the capture
            torch.cuda.current_stream().wait_stream(s)
            if self.graph_pool is None: self.graph_pool = torch.cuda.graph_pool_handle()
            g["graph"] = torch.cuda.CUDAGraph()
            with torch.cuda.graph(g["graph"], pool=self.graph_pool):
                g["out"] = self.run_padded(g["ids"], g["pos"], root)
            if len(self.graphs) >= 32: self.graphs.pop(next(iter(self.graphs)))
            self.graphs[key] = g
        self._fill(g, b_ids, b_pos)
        g["graph"].replay()
        return g["out"]

    def warm_graphs(self, prefix: str | None, questions: list[dict], max_tokens: int = 256, requests: int = 1):
        """Capture the rows graphs a call of `requests` requests with these questions can hit, for every 16-token bucket up
        to max_tokens per row, before traffic arrives (a first capture costs ~0.5 s)."""
        root = self.prefix(prefix) if prefix is not None else None
        P = 0 if root is None else root.cu[-1]
        branches = [self.branch_tokens(q) for q in questions]
        for Lb in range(16, max_tokens + 1, 16):
            rows = [[self.q_id] * max(1, Lb - len(b)) + b for _ in range(requests) for b in branches]
            rows = [r[-Lb:] for r in rows]
            if len(rows) * Lb > self.opts.graph_max_tokens: break
            self.rows_graph(rows, [list(range(P, P + len(r))) for r in rows], root)

    def _fill(self, g, b_ids, b_pos):
        R, Lb = g["ids"].shape
        ids = torch.full((R, Lb), self.tok.pad_token_id or 0, dtype=torch.long)
        pos = torch.zeros(R, Lb, dtype=torch.long)
        for r, (a, p) in enumerate(zip(b_ids, b_pos)):
            ids[r, :len(a)] = torch.tensor(a); pos[r, :len(p)] = torch.tensor(p)
            if len(p) < Lb: pos[r, len(p):] = p[-1] + 1 + torch.arange(Lb - len(p))   # pads continue the positions (never read)
        g["ids"].copy_(ids, non_blocking=True); g["pos"].copy_(pos, non_blocking=True)

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
        All requests in one call must share the prefix (serve.py groups them). -> per request, per question, probabilities.
        Requests are run in groups that fit max_pass_tokens."""
        from kev.model import user_tokens
        pre = reqs[0]["prefix"]
        if any(r["prefix"] != pre for r in reqs): raise ValueError("one call, one prefix")
        cost = [len(user_tokens(self.tok, r["content"])) + sum(len(self.branch_tokens(q)) for q in r["questions"]) for r in reqs]
        groups, cur, used = [], [], 0
        for i, c in enumerate(cost):
            if cur and used + c > self.opts.max_pass_tokens: groups.append(cur); cur, used = [], 0
            cur.append(i); used += c
        groups.append(cur)
        out = [None] * len(reqs)
        for g in groups:
            for i, p in zip(g, self._answer_group([reqs[i] for i in g])): out[i] = p
        return out

    def _answer_group(self, reqs: list[dict]) -> list[list[torch.Tensor]]:
        from kev.model import user_tokens
        pre = reqs[0]["prefix"]
        root = self.prefix(pre) if pre is not None else None
        P = 0 if root is None else root.cu[-1]
        c_ids, c_pos = [], []
        for r in reqs:
            ids = user_tokens(self.tok, r["content"]) if root is not None else [self.state_id] + user_tokens(self.tok, r["content"])
            c_ids.append(ids); c_pos.append(list(range(P, P + len(ids))))
        mode = self.opts.branch_mode
        if mode == "auto": mode = "rows" if len(reqs) <= self.opts.rows_max_requests else "two_pass"
        b_ids, b_pos, b_par, picks, ks = [], [], [], [], []
        for i, r in enumerate(reqs):
            start = P + len(c_ids[i])
            for q in r["questions"]:
                b = self.branch_tokens(q)
                lead = c_ids[i] if mode == "rows" else []             # rows: the comment again in front of each branch
                b_ids.append(lead + b); b_pos.append(list(range(start - len(lead), start + len(b)))); b_par.append(i)
                opt_ends = [len(lead) + j for j, t in enumerate(b) if t == self.c_id]
                picks.append((len(lead) + len(b) - 1, opt_ends)); ks.append(len(opt_ends))
        padded = len(b_ids) * -(-max(len(b) for b in b_ids) // 16) * 16
        if mode == "rows" and self.opts.cuda_graphs and padded <= self.opts.graph_max_tokens:
            H = self.rows_graph(b_ids, b_pos, root)                      # [R, Lb, d]
            X = torch.cat([H[r, [d] + oe] for r, (d, oe) in enumerate(picks)])
            ps = list(self.model._readout_many(X, ks))
            out, it = [], iter(ps)
            for r in reqs: out.append([next(it) for _ in r["questions"]])
            return out
        if mode == "rows":
            branches = self.run(Level(b_ids, b_pos, [0] * len(b_ids) if root is not None else None), root, want_state=False)
        else:
            content = self.run(Level(c_ids, c_pos, [0] * len(reqs) if root is not None else None), root, want_state=True)
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
