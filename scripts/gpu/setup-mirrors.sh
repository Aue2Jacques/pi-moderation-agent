#!/bin/bash
# GPU server (owner-provided, China region): point every package source at a domestic mirror, then verify each one.
# Idempotent. No credentials here. Run as root on the server: bash setup-mirrors.sh
set -euo pipefail
# apt -> aliyun (measured 0.4 s vs others)
cp -n /etc/apt/sources.list /etc/apt/sources.list.orig 2>/dev/null || true
cat > /etc/apt/sources.list <<'L'
deb https://mirrors.aliyun.com/ubuntu/ jammy main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-updates main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-backports main restricted universe multiverse
deb https://mirrors.aliyun.com/ubuntu/ jammy-security main restricted universe multiverse
L
rm -f /etc/apt/sources.list.d/*.list.bak 2>/dev/null || true
# pip (and anything reading pip.conf) -> aliyun, tuna as extra index
mkdir -p /etc /root/.pip /root/.config/pip
cat > /etc/pip.conf <<'L'
[global]
index-url = https://mirrors.aliyun.com/pypi/simple
extra-index-url = https://pypi.tuna.tsinghua.edu.cn/simple
trusted-host = mirrors.aliyun.com pypi.tuna.tsinghua.edu.cn
timeout = 120
L
cp /etc/pip.conf /root/.pip/pip.conf; cp /etc/pip.conf /root/.config/pip/pip.conf
# uv, Hugging Face, PyTorch wheels, npm: environment for every login shell
cat > /etc/profile.d/mirrors.sh <<'L'
export UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
export UV_EXTRA_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
export PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
export HF_ENDPOINT=https://hf-mirror.com
export HF_HOME=/hy-tmp/hf
export HF_HUB_DISABLE_XET=1   # hf-mirror does not serve the Xet protocol (401 from cas-server)
export TORCH_WHEELS=https://mirrors.aliyun.com/pytorch-wheels
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
L
grep -q "profile.d/mirrors.sh" /root/.bashrc || echo '. /etc/profile.d/mirrors.sh' >> /root/.bashrc
command -v npm >/dev/null && npm config set registry https://registry.npmmirror.com || true
mkdir -p /hy-tmp/hf
# verify
. /etc/profile.d/mirrors.sh
apt-get update -qq -o Acquire::Retries=3 && echo "apt ok"
pip download -q --no-deps -d /tmp/piptest six && echo "pip ok" && rm -rf /tmp/piptest
curl -s -o /dev/null -w "hf-mirror %{http_code}\n" --max-time 15 "$HF_ENDPOINT/api/models/bert-base-chinese"
curl -s -o /dev/null -w "torch wheels %{http_code}\n" --max-time 15 "$TORCH_WHEELS/"
