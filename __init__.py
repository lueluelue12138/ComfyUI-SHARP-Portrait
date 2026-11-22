import hashlib
import json
import math
import os
import sys
import importlib.util
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

import numpy as np
import torch
from PIL import Image

import comfy.model_management as memory
import comfy.utils
from comfy_api.latest import ComfyExtension, io
from comfy_extras.nodes_gaussian_splat import File3DToSplat, _lookat_camera_info, _mat_to_quat, _quat_camera_info
from comfy_execution.graph_utils import ExecutionBlocker
import folder_paths

from .fill import push_pull
from .detail import (PortraitSharpDetailComposite, PortraitSharpDetailRegion, PortraitSharpDetailSave,
                     PortraitSharpGHInput, PortraitSharpPatchSetup, PortraitSharpQwenCondition)
from .save import PortraitSharpSaveImage
from .trajectory_export import PortraitSharpTrajectoryFrame


CATEGORY = "3d/portrait"
WEB_DIRECTORY = "./web"
CHECKPOINT = "sharp_2572gikvuh.pt"
SHARP_GUI = Path(__file__).resolve().parents[3] / "sharp-gui"
SPLAT_TEMP = "portrait_sharp"
CAPTURE_TEMP = "portrait_sharp_views"


def sharp_checkpoint():
    for root in folder_paths.get_folder_paths("checkpoints"):
        candidate = Path(root) / CHECKPOINT
        if candidate.is_file():
            return candidate
    candidate = Path(torch.hub.get_dir()) / "checkpoints" / CHECKPOINT
    if candidate.is_file():
        return candidate
    raise FileNotFoundError(f"找不到 SHARP 权重 {CHECKPOINT}。请放进 models/checkpoints。")


class PortraitSharpPredict(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpPredict",
            display_name="SHARP · 单图建高斯",
            category=CATEGORY,
            inputs=[
                io.Image.Input("image"),
                io.Float.Input("lens_mm", display_name="等效焦距 (mm)", default=30.0,
                               min=12.0, max=120.0, step=0.5, advanced=True),
            ],
            outputs=[io.Splat.Output(display_name="高斯"), io.Float.Output(display_name="焦距"),
                     io.File3DPLY.Output(display_name="PLY 预览")],
        )

    @classmethod
    def execute(cls, image, lens_mm):
        checkpoint = sharp_checkpoint()
        pixels = (image[0, ..., :3].detach().cpu().clamp(0, 1) * 255).round().byte().numpy()
        checksum = hashlib.sha256(pixels.tobytes())
        checksum.update(repr((pixels.shape, lens_mm, checkpoint, checkpoint.stat().st_mtime_ns)).encode())
        cache = Path(folder_paths.get_temp_directory(), SPLAT_TEMP)
        cache.mkdir(parents=True, exist_ok=True)
        ply = cache / f"{checksum.hexdigest()}.ply"
        if not ply.is_file():
            cls.build(pixels, lens_mm, checkpoint, ply)
        model = io.File3DPLY.Type(str(ply))
        return io.NodeOutput(File3DToSplat.execute(model)[0], lens_mm, model)

    @staticmethod
    def build(pixels, lens_mm, checkpoint, destination):
        configured = os.environ.get("PORTRAIT_SHARP_PYTHON")
        if configured:
            python = Path(configured).expanduser()
        elif importlib.util.find_spec("sharp") is not None:
            python = Path(sys.executable)
        else:
            python = SHARP_GUI / "venv" / "Scripts" / "python.exe"
        if not python.is_file():
            raise FileNotFoundError("请安装 Apple SHARP，并将 PORTRAIT_SHARP_PYTHON 设置为该环境的 Python 完整路径。详见项目 README。")
        memory.unload_all_models()
        memory.soft_empty_cache()
        with TemporaryDirectory(prefix="build-", dir=destination.parent) as scratch:
            scratch = Path(scratch)
            source, ply, log = (scratch / name for name in ("reference.png", "sharp.ply", "sharp.log"))
            Image.fromarray(pixels).save(source, compress_level=1)
            command = [str(python), str(Path(__file__).with_name("predict_sharp.py")),
                       str(source), str(ply), str(checkpoint), str(lens_mm)]
            with log.open("wb") as output, subprocess.Popen(
                command, stdout=output, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ) as child:
                try:
                    while True:
                        try:
                            child.wait(timeout=0.25)
                            break
                        except subprocess.TimeoutExpired:
                            memory.throw_exception_if_processing_interrupted()
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
            if child.returncode or not ply.is_file():
                raise RuntimeError("SHARP 建模失败。\n" + log.read_text(encoding="utf-8", errors="replace")[-4000:])
            ply.replace(destination)


def output_size(width, height, long_edge):
    ratio = long_edge / max(width, height)
    return tuple(max(64, math.floor(size * ratio / 32 + 0.5) * 32) for size in (width, height))


def read_view_capture(filename, width, height):
    if not isinstance(filename, str) or not re.fullmatch(r"[a-f0-9-]{36}\.png", filename):
        raise ValueError("找不到当前机位的取景图，请重新点击「② 修复当前机位」。")
    path = Path(folder_paths.get_temp_directory(), CAPTURE_TEMP, filename)
    if not path.is_file():
        raise ValueError("取景图已过期，请重新点击「② 修复当前机位」。")
    with Image.open(path) as frame:
        if frame.format != "PNG" or frame.size != (width, height):
            raise ValueError("取景图与当前输出尺寸不一致，请重新点击「② 修复当前机位」。")
        pixels = torch.from_numpy(np.array(frame.convert("RGBA"))).float() / 255.0
    alpha = pixels[..., 3]
    if (alpha >= 4 / 255).float().mean() < 0.001:
        raise ValueError("当前机位几乎看不到高斯，请拖动调整构图后再修复。")
    return (pixels[..., :3] * alpha[..., None])[None], alpha[None]


class PortraitSharpVisualCamera(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpVisualCamera",
            display_name="人物换视角 · 3D 相机",
            category=CATEGORY,
            is_output_node=True,
            inputs=[
                io.File3DPLY.Input("model"),
                io.Image.Input("image"),
                io.Float.Input("lens_mm", force_input=True),
                io.Int.Input("long_edge", display_name="输出长边 (px)", default=1280,
                             min=512, max=2560, step=32),
                io.String.Input("camera", default="", socketless=True),
                io.Int.Input("reference_edge", display_name="原图参考长边 (px)", default=1536,
                             min=512, max=2560, step=32, optional=True,
                             tooltip="原图参考的像素上限。小图保留原尺寸；尺寸越大，内存占用越高。"),
            ],
            outputs=[io.Load3DCamera.Output(display_name="目标相机"), io.Int.Output(display_name="宽"),
                     io.Int.Output(display_name="高"), io.Image.Output(display_name="原图参考"),
                     io.Image.Output(display_name="当前机位粗图"), io.Mask.Output(display_name="高斯覆盖")],
        )

    @classmethod
    def execute(cls, model, image, lens_mm, long_edge, camera, reference_edge=1536):
        path = Path(model.get_source()).resolve()
        if path.parent != Path(folder_paths.get_temp_directory(), SPLAT_TEMP).resolve():
            raise ValueError("请连接工作流中的 SHARP 高斯输出。")
        height, width = image.shape[1:3]
        focal = lens_mm * math.hypot(width, height) / math.hypot(36, 24)
        info = {"token": path.stem, "name": "人物高斯", "size_mb": round(path.stat().st_size / 2**20, 1),
                "url": f"/view?type=temp&subfolder={SPLAT_TEMP}&filename={path.name}",
                "intrinsics": [[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1]]}
        ui = {"portrait_sharp_view": [info]}
        saved = json.loads(camera) if camera else {}
        if saved.get("token") != path.stem:
            return io.NodeOutput(*(ExecutionBlocker(None) for _ in range(6)), ui=ui)

        view = torch.tensor(saved["w2c"], dtype=torch.float64)
        intrinsics = torch.tensor(saved["K"], dtype=torch.float64)
        fw, fh = int(saved["width"]), int(saved["height"])
        rotation = view[:3, :3]
        if (view.shape != (4, 4) or intrinsics.shape != (3, 3) or not 0 < fw <= width or not 0 < fh <= height
                or not torch.isfinite(view).all() or not torch.isfinite(intrinsics).all()
                or intrinsics[0, 0] <= 0 or not torch.allclose(rotation @ rotation.T, torch.eye(3, dtype=view.dtype), atol=1e-4)
                or abs(torch.linalg.det(rotation).item() - 1.0) > 1e-4):
            raise ValueError("机位数据无效，请在 3D 预览里重新选择。")

        out_w, out_h = output_size(fw, fh, long_edge)
        flip = view.new_tensor([1, -1, -1])
        eye = -(rotation.T @ view[:3, 3]) * flip
        world_rotation = (flip[:, None] * rotation.T * flip[None, :]).float()
        quat = _mat_to_quat(world_rotation[None])[0][[1, 2, 3, 0]]
        fov = math.degrees(2 * math.atan(min(fw, fh) / (2 * float(intrinsics[0, 0]))))
        target_camera = _quat_camera_info(eye.float(), quat, fov, torch.device("cpu"))

        ref_w, ref_h = output_size(width, height, min(max(width, height), reference_edge))
        reference = comfy.utils.common_upscale(image[:1, ..., :3].movedim(-1, 1), ref_w, ref_h,
                                              "lanczos", "disabled").movedim(1, -1)
        capture = saved.get("capture")
        if capture is None:
            # Old workflows still connect the camera outputs to ComfyUI's Render Splat.
            frame, coverage = ExecutionBlocker(None), ExecutionBlocker(None)
        else:
            frame, coverage = read_view_capture(capture, out_w, out_h)
        return io.NodeOutput(target_camera, out_w, out_h, reference, frame, coverage, ui=ui)


class PortraitSharpCamera(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpCamera",
            display_name="人物相机 · 调整机位",
            category=CATEGORY,
            inputs=[
                io.Splat.Input("splat"),
                io.Image.Input("image"),
                io.Float.Input("yaw", display_name="左右角度 (°)", default=20.0, min=-89.0, max=89.0, step=1.0),
                io.Float.Input("pitch", display_name="俯仰角度 (°)", default=0.0, min=-60.0, max=60.0, step=1.0),
                io.Float.Input("distance", display_name="相机距离倍率", default=1.0, min=0.5, max=2.0, step=0.05),
                io.Int.Input("long_edge", display_name="出图长边", default=768, min=384, max=1536, step=32),
                io.Float.Input("pivot_scale", display_name="环绕支点深度倍率", default=1.0,
                               min=0.25, max=4.0, step=0.05, advanced=True),
                io.Float.Input("lens_mm", display_name="建模焦距", force_input=True),
            ],
            outputs=[io.Load3DCamera.Output(display_name="目标相机"), io.Int.Output(display_name="宽"),
                     io.Int.Output(display_name="高"), io.Image.Output(display_name="原图参考")],
        )

    @classmethod
    def execute(cls, splat, image, yaw, pitch, distance, long_edge, pivot_scale, lens_mm):
        height, width = image.shape[1:3]
        ratio = long_edge / max(width, height)
        out_w = max(64, round(width * ratio / 32) * 32)
        out_h = max(64, round(height * ratio / 32) * 32)
        focal = lens_mm * math.hypot(width, height) / math.hypot(36, 24)
        x, y, z = splat.positions[0].unbind(-1)
        valid = torch.isfinite(z) & (z > 0.01) & (splat.opacities[0, :, 0] > 0.05)
        center = valid & (x.abs() < z * width / focal * 0.16) & (y.abs() < z * height / focal * 0.20)
        depths = z[center] if center.any() else z[valid]
        if not depths.numel():
            raise ValueError("高斯里找不到有效的前景深度。请换一张人物靠近画面中心的照片。")
        pivot = float(depths.quantile(0.35)) * pivot_scale
        target = (0.0, 0.0, -pivot)
        yaw, pitch = map(math.radians, (yaw, pitch))
        radius = pivot * distance
        eye = (radius * math.sin(yaw) * math.cos(pitch), radius * math.sin(pitch),
               target[2] + radius * math.cos(yaw) * math.cos(pitch))
        focal_out = focal * min(out_w, out_h) / min(width, height)
        fov = math.degrees(2 * math.atan(min(out_w, out_h) / (2 * focal_out)))
        camera = _lookat_camera_info(eye, target, fov, torch.device("cpu"))
        reference = comfy.utils.common_upscale(image[:1, ..., :3].movedim(-1, 1), out_w, out_h,
                                              "lanczos", "disabled").movedim(1, -1)
        return io.NodeOutput(camera, out_w, out_h, reference)


class PortraitSplatFill(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSplatFill",
            display_name="Splat Repair · 空洞预填充",
            category=CATEGORY,
            inputs=[io.Image.Input("image"), io.Mask.Input("coverage")],
            outputs=[io.Image.Output(display_name="目标视角参考")],
        )

    @classmethod
    def execute(cls, image, coverage):
        # Comfy's Render Splat mask is coverage; the original viewer exposes 1 - coverage.
        output = [push_pull(rgb.float().cpu(), (alpha.cpu() >= 4 / 255).float())
                  for rgb, alpha in zip(image[..., :3], coverage, strict=True)]
        return io.NodeOutput(torch.stack(output))


class PortraitSharpExtension(ComfyExtension):
    async def get_node_list(self):
        return [PortraitSharpPredict, PortraitSharpCamera, PortraitSharpVisualCamera, PortraitSplatFill,
                PortraitSharpTrajectoryFrame, PortraitSharpQwenCondition, PortraitSharpDetailRegion,
                PortraitSharpDetailComposite, PortraitSharpDetailSave, PortraitSharpSaveImage,
                PortraitSharpPatchSetup, PortraitSharpGHInput]


async def comfy_entrypoint():
    return PortraitSharpExtension()
