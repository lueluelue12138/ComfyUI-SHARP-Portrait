import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image

from comfy_api.latest import io
import folder_paths


class PortraitSharpTrajectoryFrame(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpTrajectoryFrame",
            display_name="SHARP · 保存轨迹帧",
            category="3d/portrait",
            is_output_node=True,
            inputs=[io.Image.Input("image"), io.String.Input("sequence"), io.String.Input("metadata")],
            outputs=[],
        )

    @classmethod
    def execute(cls, image, sequence, metadata):
        if not re.fullmatch(r"\d{8}-\d{6}-[a-f0-9]{8}", sequence):
            raise ValueError("无效的轨迹导出编号。")
        data = json.loads(metadata)
        index, count = int(data["index"]), int(data["count"])
        mode = data["mode"]
        if not 1 <= index <= count or mode not in {"repair", "preview"} or image.shape[0] != 1:
            raise ValueError("无效的轨迹帧设置。")

        height, width = image.shape[1:3]
        camera = data["camera"]
        if (width, height) != (data["width"], data["height"]):
            raise ValueError(f"轨迹帧实际为 {width} × {height}，和导出机位尺寸不一致。")
        w2c = np.array(camera["w2c"], dtype=np.float64)
        k = np.array(camera["K"], dtype=np.float64)
        c2w = np.linalg.inv(w2c)
        c2w[:, 1:3] *= -1  # OpenCV camera axes to the OpenGL camera axes used by transforms.json.
        k[0] *= width / camera["width"]
        k[1] *= height / camera["height"]
        filename = f"frame_{index:05}.png"
        subfolder = Path("人物换视角", "相机轨迹", sequence)
        directory = Path(folder_paths.get_output_directory(), subfolder)
        directory.mkdir(parents=True, exist_ok=True)
        manifest_path = directory / "transforms.json"
        manifest = {
            "camera_model": "OPENCV", "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0,
            "planned_frames": count, "image_source": mode, "frames": [],
        }
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest["planned_frames"] != count or manifest["image_source"] != mode:
            raise ValueError("导出目录已有不同设置的轨迹。")

        result = directory / filename
        frames = manifest["frames"]
        ui = {"images": [{"filename": filename, "subfolder": subfolder.as_posix(), "type": "output"}]}
        if any(frame["frame_index"] == index for frame in frames) and result.is_file():
            return io.NodeOutput(ui=ui)
        frame = {
            "file_path": filename, "frame_index": index, "keyframe": data["keyframe"],
            "w": width, "h": height, "fl_x": float(k[0, 0]), "fl_y": float(k[1, 1]),
            "cx": float(k[0, 2]), "cy": float(k[1, 2]), "transform_matrix": c2w.tolist(),
        }
        manifest["frames"] = sorted([f for f in frames if f["frame_index"] != index] + [frame],
                                    key=lambda f: f["frame_index"])
        pixels = (image[0, ..., :3].detach().cpu().clamp(0, 1) * 255).round().byte().numpy()
        with TemporaryDirectory(dir=directory) as scratch:
            png = Path(scratch, filename)
            index_file = Path(scratch, "transforms.json")
            Image.fromarray(pixels).save(png, compress_level=4)
            index_file.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            png.replace(result)
            try:
                index_file.replace(manifest_path)
            except OSError:
                result.unlink(missing_ok=True)
                raise
        return io.NodeOutput(ui=ui)
