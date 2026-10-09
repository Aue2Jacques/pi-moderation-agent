"""Shared helpers: load a Kev checkpoint for kevfast, and turn a /v1/systemone request into engine requests."""
from __future__ import annotations

from dataclasses import replace


def load(run: str):
    """-> (tok, model): bf16, kev's fused Qwen3.5 kernels, eager (no CUDA graphs), torch backend."""
    import torch
    from kev.checkpoint import Checkpoint, LoadOptions, fused_available
    if not fused_available(): raise RuntimeError("kevfast needs kev's fused kernels (flash-linear-attention installed)")
    opts = replace(LoadOptions.from_env(), dtype=torch.bfloat16, cuda_graphs=False, fused=True, backend="torch")
    tok, model = Checkpoint(run).load("cuda", opts)
    return tok, model.eval()


def load_vision(model):
    """The base checkpoint's vision encoder (Kev keeps only the language model) on the model's device, bf16, and the
    base's image processor (needs torchvision). The multimodal base is read on the CPU and only `visual` is kept."""
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoImageProcessor, Qwen3_5ForConditionalGeneration
    base = model.lm.config.name_or_path if getattr(model.lm.config, "name_or_path", "") else "Qwen/Qwen3.5-4B-Base"
    bdir = snapshot_download("Qwen/Qwen3.5-4B-Base" if "Qwen3.5-4B" in base or not base else base, allow_patterns=["*.json", "*.safetensors", "*.txt"])
    mm = Qwen3_5ForConditionalGeneration.from_pretrained(bdir, dtype=torch.bfloat16)
    visual = mm.model.visual.to(model.device).eval()
    del mm
    return visual, AutoImageProcessor.from_pretrained(bdir)


def to_engine_request(state, questions: dict, layout: str, confirm: bool):
    """state: the request's JSON state; questions: {key: {"type": "choice", "instructions", "criteria"}}.
    -> (engine request, kev meta for to_answers, the question keys kept). rules_first splits a state whose first field is
    "rules": the rules block is the prefix; the rest is the content."""
    from kev.api import render, option_text, question_keys
    keep = [k for k in questions if confirm or not k.endswith("#confirm")]
    prefix = None
    if layout == "rules_first" and isinstance(state, dict) and next(iter(state), None) == "rules":
        prefix = render({"rules": state["rules"]})
        state = {k: v for k, v in state.items() if k != "rules"}
    image = None
    if isinstance(state, dict) and isinstance(state.get("content"), dict) and state["content"].get("image") is not None:
        from kevfast.engine import IMAGE_MARK
        image = state["content"]["image"]
        if isinstance(image, str):                                     # a data URL or bare base64 over HTTP
            import base64, io
            from PIL import Image
            image = Image.open(io.BytesIO(base64.b64decode(image.split(",", 1)[-1]))).convert("RGB")
        state = {**state, "content": {**state["content"], "image": IMAGE_MARK}}
    qs, meta = [], []
    for k in keep:
        q = questions[k]
        if q["type"] != "choice": raise ValueError(f"kevfast answers choice questions only ({k})")
        crit = q["criteria"]
        qs.append({"key": k.split("#")[0], "instr": render(q.get("instructions")), "options": [option_text(n, d) for n, d in crit.items()], "names": list(crit)})
        meta.append({"id": k, "type": "choice", "keys": question_keys("choice", crit)})
    return {"prefix": prefix, "content": render(state), "questions": qs, **({"image": image} if image is not None else {})}, meta, keep
