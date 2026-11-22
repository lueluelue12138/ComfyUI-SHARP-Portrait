import hashlib
import json
import math
from pathlib import Path
import re

import numpy as np
from PIL import Image, ImageOps
from scipy.ndimage import distance_transform_edt
import torch

import comfy.model_management as memory
import comfy.utils
from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker
import folder_paths
import node_helpers
import nodes

from .save import image_preview, output_directory_input, save_destination

CATEGORY = "3d/portrait"
DETAIL_TEMP = "portrait_sharp_detail"
DETAIL_MASKS = "portrait_sharp_masks"
DETAIL_REFERENCES = "portrait_sharp_references"
PATCH = io.Custom("PORTRAIT_SHARP_PATCH")
DETAIL_PROMPT = (
    "Refine facial, hair and clothing details in image 1 using image 2 as a reference. "
    "Keep the viewpoint, pose, expression, identity and lighting of image 1."
)
REMOVE_PROMPT = "移除图像中的绿色区域"
EDIT_MODES = {"refine", "redraw", "remove"}
REFERENCE_EDGES = {768, 1024, 1344, 1536, 2048}


def resize_image(image, width, height):
    if image.shape[1:3] == (height, width):
        return image
    return comfy.utils.common_upscale(image.movedim(-1, 1), width, height, "lanczos", "disabled").movedim(1, -1)


class PortraitSharpQwenCondition(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpQwenCondition", display_name="Qwen 2.1 · Turbo 双图编码", category=CATEGORY,
            inputs=[io.Clip.Input("clip"), io.Vae.Input("vae"), io.Image.Input("image_1"), io.Image.Input("image_2"),
                    io.String.Input("prompt", multiline=True, dynamic_prompts=True),
                    io.Boolean.Input("start_from_image", display_name="从图 1 开始重绘", default=False, advanced=True),
                    io.Mask.Input("noise_mask", display_name="局部重绘遮罩", optional=True),
                    PATCH.Input("edit_patch", display_name="遮罩编辑设置", optional=True)],
            outputs=[io.Conditioning.Output(display_name="positive"), io.Latent.Output(display_name="latent")],
        )

    @classmethod
    def execute(cls, clip, vae, image_1, image_2, prompt, start_from_image, noise_mask=None, edit_patch=None):
        mode = edit_patch.get("edit_mode") if edit_patch else None
        if mode == "remove":
            mask = noise_mask.to(image_1.device, dtype=image_1.dtype)[..., None]
            green = image_1.new_tensor([0, 1, 0])
            image_1 = image_1[..., :3].lerp(green, mask * 0.4)
            image_2 = None
            prompt = f"{REMOVE_PROMPT}。{prompt.strip()}" if prompt.strip() else REMOVE_PROMPT
        elif mode == "redraw":
            if not prompt.strip():
                raise ValueError("局部重绘需要填写编辑指令。")
            if not edit_patch["reference_selected"]:
                image_2 = None
        elif mode == "refine":
            prompt = prompt.strip() or DETAIL_PROMPT
        references, latents = [], []
        for image in (image_1, image_2):
            if image is None:
                continue
            height, width = image.shape[1:3]
            pixels = resize_image(image[:1], max(32, round(width / 32) * 32), max(32, round(height / 32) * 32))
            rgb = pixels[..., :3]
            if pixels.shape[-1] > 3:
                alpha = pixels[..., 3:]
                rgb = rgb * alpha + (1.0 - alpha)
            references.append(rgb)
            latents.append(vae.encode(pixels))
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(
            prompt, images=references, keep_vision=False, prevent_empty_text=True,
        ))
        positive = node_helpers.conditioning_set_values(positive, {"reference_latents": latents}, append=True)
        height, width = references[0].shape[1:3]
        samples = latents[0] if start_from_image else torch.zeros(
            (1, 64, height // 16, width // 16), device=memory.intermediate_device(),
        )
        latent = {"samples": samples}
        if start_from_image and noise_mask is not None and mode not in EDIT_MODES:
            latent["noise_mask"] = noise_mask
        return io.NodeOutput(positive, latent)


class PortraitSharpPatchSetup(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpPatchSetup", display_name="遮罩编辑 · 模型与采样", category=CATEGORY,
            inputs=[io.Model.Input("model"), io.Sigmas.Input("sigmas"), PATCH.Input("patch")],
            outputs=[io.Model.Output(display_name="model"), io.Sigmas.Output(display_name="sigmas")],
        )

    @classmethod
    def execute(cls, model, sigmas, patch):
        remove = patch["edit_mode"] == "remove"
        name = "Qwen2.1_万物移除Remove_GH.safetensors" if remove else "Qwen2.1 一致性无偏移_GH_V1.0.safetensors"
        model, = nodes.LoraLoaderModelOnly().load_lora_model_only(model, name, 1.0 if remove else 0.48)
        denoise = 1.0 if remove else patch["denoise"]
        steps = max(1, round((len(sigmas) - 1) * denoise))
        return io.NodeOutput(model, sigmas[-(steps + 1):])


def detail_preview(image):
    pixels = (image[0, ..., :3].detach().cpu().clamp(0, 1) * 255).byte().numpy()
    key = hashlib.sha256(repr(pixels.shape).encode() + pixels.tobytes()).hexdigest()
    filename = f"{key}.png"
    folder = Path(folder_paths.get_temp_directory(), DETAIL_TEMP)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    if not path.is_file():
        Image.fromarray(pixels).save(path, compress_level=2)
    height, width = pixels.shape[:2]
    return {"filename": filename, "subfolder": DETAIL_TEMP, "type": "temp", "width": width, "height": height}


def read_image(filename, uploaded=False):
    if uploaded:
        if not isinstance(filename, str) or not re.fullmatch(r"[a-f0-9-]{36}\.(png|jpe?g|webp|bmp)", filename):
            raise ValueError("参考图片无效，请重新上传。")
        path = Path(folder_paths.get_input_directory(), DETAIL_REFERENCES, filename)
    else:
        if not isinstance(filename, str) or not re.fullmatch(r"[a-f0-9]{64}\.png", filename):
            raise ValueError("精修预览无效，请重新生成基础图。")
        path = Path(folder_paths.get_temp_directory(), DETAIL_TEMP, filename)
    if not path.is_file():
        raise ValueError("参考图找不到，请重新上传。" if uploaded else "精修预览已过期，请重新生成基础图。")
    with Image.open(path) as image:
        rgb = ImageOps.exif_transpose(image).convert("RGB")
        return torch.from_numpy(np.array(rgb)).float().unsqueeze(0) / 255


def read_mask(filename, width, height):
    if not isinstance(filename, str) or not re.fullmatch(r"[a-f0-9-]{36}\.png", filename):
        raise ValueError("遮罩无效，请重新绘制。")
    path = Path(folder_paths.get_temp_directory(), DETAIL_MASKS, filename)
    if not path.is_file():
        raise ValueError("遮罩已过期，请重新绘制。")
    with Image.open(path) as image:
        alpha = image.getchannel("A").resize((width, height), Image.Resampling.NEAREST)
        return np.asarray(alpha) > 5


def mask_bounds(mask):
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    if not len(rows) or not len(cols):
        raise ValueError("遮罩为空，请涂上要精修的区域。")
    left, top, right, bottom = int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1
    if right - left < 8 or bottom - top < 8:
        raise ValueError("遮罩范围太小，请扩大涂抹区域。")
    return left, top, right, bottom


def bounds(region, width, height):
    if len(region) != 4 or any(not math.isfinite(value) or not 0 <= value <= 1 for value in region):
        raise ValueError("选区无效，请重新框选。")
    left, top, right, bottom = (round(f * n) for f, n in zip(region, (width, height, width, height)))
    if right - left < 8 or bottom - top < 8:
        raise ValueError("选区太小，请框住需要精修的部位。")
    return left, top, right, bottom


def scaled_crop(image, box, edge):
    left, top, right, bottom = box
    crop = image[:, top:bottom, left:right]
    scale = edge / max(right - left, bottom - top)
    return resize_image(crop, max(32, round((right - left) * scale / 32) * 32),
                        max(32, round((bottom - top) * scale / 32) * 32))


def sample_detail_reference(reference, edge):
    if type(edge) is not int or edge not in REFERENCE_EDGES:
        raise ValueError("无效的参考图采样长边。")
    height, width = reference.shape[1:3]
    scale = min(1.0, edge / max(width, height))
    width, height = max(1, round(width * scale)), max(1, round(height * scale))
    reference = resize_image(reference, width, height)
    # GH encodes on a 32-pixel grid. Pad to that grid without stretching the reference.
    canvas_w, canvas_h = (width + 31) // 32 * 32, (height + 31) // 32 * 32
    if (canvas_w, canvas_h) == (width, height):
        return reference
    canvas = reference.new_full((1, canvas_h, canvas_w, 3), 128.0 / 255.0)
    x, y = (canvas_w - width) // 2, (canvas_h - height) // 2
    canvas[:, y:y + height, x:x + width] = reference
    return canvas


class PortraitSharpDetailRegion(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpDetailRegion", display_name="人物换视角 · 局部精修选区", category=CATEGORY,
            is_output_node=True,
            inputs=[io.String.Input("selection", default="", socketless=True),
                    io.Int.Input("detail_edge", display_name="局部采样长边", default=896, min=384, max=1536, step=32),
                    io.Int.Input("feather", display_name="贴回羽化 (px)", default=12, min=0, max=128, advanced=True),
                    io.Image.Input("image", optional=True), io.Image.Input("reference", optional=True)],
            outputs=[io.Image.Output(display_name="新机位局部"), io.Image.Output(display_name="原图参考"),
                     PATCH.Output(display_name="贴回数据"), io.Mask.Output(display_name="局部采样遮罩"),
                     io.Image.Output(display_name="精修前")],
        )

    @classmethod
    def execute(cls, selection, detail_edge, feather, image=None, reference=None):
        if not selection:
            ui = {} if image is None or reference is None else {
                "portrait_detail": [dict(target=detail_preview(image), source=detail_preview(reference))],
            }
            return io.NodeOutput(*(ExecutionBlocker(None) for _ in range(5)), ui=ui)

        data = json.loads(selection)
        image = read_image(data["target"])
        reference = read_image(data["source"], uploaded=data.get("uploaded") is True)
        height, width = image.shape[1:3]
        if data.get("mask"):
            mask = read_mask(data["mask"], width, height)
            left, top, right, bottom = roi = mask_bounds(mask)
        else:
            left, top, right, bottom = roi = bounds(data["region"], width, height)
            mask = np.zeros((height, width), dtype=bool)
            mask[top:bottom, left:right] = True
        pad = round(max(right - left, bottom - top) * 0.30)
        cx, cy, cr, cb = context = max(0, left - pad), max(0, top - pad), min(width, right + pad), min(height, bottom + pad)
        rh, rw = reference.shape[1:3]
        if data.get("source_mask"):
            source_mask = read_mask(data["source_mask"], rw, rh)
            sx, sy, sr, sb = mask_bounds(source_mask)
            reference = torch.where(torch.from_numpy(source_mask[sy:sb, sx:sr])[None, ..., None],
                                    reference[:, sy:sb, sx:sr], 0.5)
            ref_box = (0, 0, sr - sx, sb - sy)
        else:
            ref_box = bounds(data["source_region"], rw, rh) if data.get("source_region") else (0, 0, rw, rh)
        ref_limit = 1280 if data.get("uploaded") or data.get("source_mask") else 1024
        ref_edge = min(ref_limit, max(ref_box[2] - ref_box[0], ref_box[3] - ref_box[1]))
        crop = scaled_crop(image, context, detail_edge)
        crop_mask = torch.from_numpy(mask[cy:cb, cx:cr].copy()).float()[None, None]
        sample_mask = torch.nn.functional.interpolate(crop_mask, crop.shape[1:3], mode="nearest")[:, 0]
        patch = {"image": image, "base_name": data["target"], "context": context, "roi": roi, "feather": feather}
        if "edit_mode" in data:
            mode = data["edit_mode"]
            denoise = data.get("denoise", 0.78)
            if mode not in EDIT_MODES or not math.isfinite(denoise) or not 0.1 <= denoise <= 1:
                raise ValueError("遮罩编辑模式或幅度无效。")
            patch.update(edit_mode=mode, denoise=denoise,
                         reference_selected=bool(data.get("uploaded") or data.get("source_mask")))
        if data.get("mask"):
            patch["mask"] = mask[top:bottom, left:right]
        return io.NodeOutput(crop, scaled_crop(reference, ref_box, ref_edge), patch, sample_mask, image)


class PortraitSharpDetailComposite(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpDetailComposite", display_name="局部精修 · 羽化贴回", category=CATEGORY,
            inputs=[io.Image.Input("image"), PATCH.Input("patch")], outputs=[io.Image.Output(display_name="精修成图")],
        )

    @classmethod
    def execute(cls, image, patch):
        cx, cy, cr, cb = patch["context"]
        x, y, r, b = patch["roi"]
        original = patch["image"]
        crop = resize_image(image[..., :3], cr - cx, cb - cy).to(original.device)
        patch_rgb = crop[:, y - cy:b - cy, x - cx:r - cx]
        result = original.clone()
        region = result[:, y:b, x:r]
        feather = patch["feather"]
        if "mask" in patch:
            mask = patch["mask"]
            if feather:
                distances = distance_transform_edt(np.pad(mask, 1))[1:-1, 1:-1]
                weight = torch.from_numpy(distances).to(original.device, dtype=torch.float32)
                weight = (weight / min(feather, distances.max())).clamp(0, 1)
                weight = weight.square() * (3 - 2 * weight)
            else:
                weight = torch.from_numpy(mask).to(original.device, dtype=torch.float32)
            region.lerp_(patch_rgb, weight[None, ..., None])
        elif feather:
            feather = min(feather, max(1, min(r - x, b - y) // 2))
            axis_x = torch.arange(r - x, dtype=torch.float32, device=original.device) + 0.5
            axis_y = torch.arange(b - y, dtype=torch.float32, device=original.device) + 0.5
            border = torch.minimum(torch.minimum(axis_x, r - x - axis_x)[None, :],
                                   torch.minimum(axis_y, b - y - axis_y)[:, None])
            weight = (border / feather).clamp(0, 1)[None, ..., None]
            weight = weight.square() * (3 - 2 * weight)
            region.lerp_(patch_rgb, weight)
        else:
            region.copy_(patch_rgb)
        return io.NodeOutput(result)


class PortraitSharpGHInput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpGHInput", display_name="人物换视角 · 孤海编辑输入", category=CATEGORY,
            is_output_node=True,
            inputs=[io.String.Input("selection", default="", socketless=True),
                    io.Image.Input("image", optional=True), io.Image.Input("reference", optional=True)],
            outputs=[io.Image.Output(display_name="新机位成图"), io.Mask.Output(display_name="原尺寸遮罩"),
                     io.Image.Output(display_name="可选参考图"), io.Boolean.Output(display_name="执行移除"),
                     PATCH.Output(display_name="保存信息")],
        )

    @classmethod
    def execute(cls, selection, image=None, reference=None):
        if not selection:
            ui = {} if image is None or reference is None else {
                "portrait_detail": [dict(target=detail_preview(image), source=detail_preview(reference))],
            }
            return io.NodeOutput(*(ExecutionBlocker(None) for _ in range(5)), ui=ui)
        data = json.loads(selection)
        mode = data.get("edit_mode")
        if mode not in EDIT_MODES:
            raise ValueError("请选择一种遮罩编辑模式。")
        target = read_image(data["target"])
        height, width = target.shape[1:3]
        mask = read_mask(data.get("mask"), width, height)
        mask_bounds(mask)
        reference = None
        if mode != "remove" and (mode == "refine" or data.get("use_reference") or data.get("uploaded") or data.get("source_mask")):
            reference = read_image(data["source"], uploaded=data.get("uploaded") is True)
            rh, rw = reference.shape[1:3]
            left, top, right, bottom = bounds(data["source_crop"], rw, rh) if data.get("source_crop") else (0, 0, rw, rh)
            if data.get("source_mask"):
                mask = read_mask(data["source_mask"], rw, rh)[top:bottom, left:right]
                if not mask.any():
                    raise ValueError("右图的遮罩和裁切框没有重叠。")
                x, y, r, b = mask_bounds(mask)
                right, bottom = left + r, top + b
                left, top = left + x, top + y
            reference = reference[:, top:bottom, left:right]
            if "reference_edge" in data:
                reference = sample_detail_reference(reference, data["reference_edge"])
        return io.NodeOutput(target, torch.from_numpy(mask).float()[None], reference,
                             mode == "remove", {"base_name": data["target"], "native_gh": True})


class PortraitSharpDetailSave(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpDetailSave", display_name="局部精修 · 保存结果", category=CATEGORY, is_output_node=True,
            inputs=[io.Image.Input("image"), PATCH.Input("patch"),
                    io.String.Input("filename_prefix", display_name="文件名前缀", default="人物换视角/调优版/精修/局部精修"),
                    output_directory_input()], outputs=[],
        )

    @classmethod
    def execute(cls, image, patch, filename_prefix, output_directory=""):
        height, width = image.shape[1:3]
        root, prefix = save_destination(filename_prefix, output_directory)
        directory, stem, counter, folder, _ = folder_paths.get_save_image_path(
            prefix, root, width, height,
        )
        filename = f"{stem}_{counter:05}_.png"
        pixels = image[0, ..., :3].detach().cpu().clamp(0, 1) * 255
        if not patch.get("native_gh"):
            pixels = pixels.round()
        Image.fromarray(pixels.byte().numpy()).save(Path(directory, filename), compress_level=4)
        item = image_preview(root, folder, filename)
        return io.NodeOutput(ui={"images": [item], "portrait_detail_result": [{**item, "before": patch["base_name"]}]})
