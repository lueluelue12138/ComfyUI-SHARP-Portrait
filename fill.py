# SPDX-License-Identifier: MIT
# Copyright (c) 2026 aaljman
# Adapted from splat-repair-lora v1.1, comfyui-gaussian-viewer/nodes.py.

import torch


def _srgb_to_linear(c: torch.Tensor) -> torch.Tensor:
    return torch.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: torch.Tensor) -> torch.Tensor:
    return torch.where(c <= 0.0031308, c * 12.92, 1.055 * c.clamp(min=0.0031308) ** (1 / 2.4) - 0.055)


def push_pull(rgb: torch.Tensor, solid: torch.Tensor) -> torch.Tensor:
    """Fill the pixels where `solid` is 0 from the solid ones around them: average down a pyramid of
    halved images (weighted by coverage), then push the coarse colours back up into the gaps.
    rgb is HxWx3 sRGB in 0..1, solid HxW in {0, 1}. Blends in linear light."""
    levels = [(_srgb_to_linear(rgb) * solid[..., None], solid)]
    while min(levels[-1][1].shape) > 1:
        c, w = levels[-1]
        h2, w2 = (w.shape[0] + 1) // 2, (w.shape[1] + 1) // 2
        c = torch.nn.functional.pad(c, (0, 0, 0, w2 * 2 - c.shape[1], 0, h2 * 2 - c.shape[0]))
        w = torch.nn.functional.pad(w, (0, w2 * 2 - w.shape[1], 0, h2 * 2 - w.shape[0]))
        levels.append((c.reshape(h2, 2, w2, 2, 3).sum((1, 3)), w.reshape(h2, 2, w2, 2).sum((1, 3))))
    out = None
    for c, w in reversed(levels):
        est = torch.where(w[..., None] > 0, c / w.clamp(min=1e-9)[..., None], torch.zeros_like(c))
        if out is None:
            out = est
            continue
        conf = w.clamp(max=1.0)[..., None]
        up = out.repeat_interleave(2, 0).repeat_interleave(2, 1)[: w.shape[0], : w.shape[1]]
        out = est * conf + up * (1 - conf)
    filled = _linear_to_srgb(out).clamp(0, 1)
    return torch.where(solid[..., None] > 0, rgb, filled)
