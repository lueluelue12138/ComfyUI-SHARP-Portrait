import asyncio
import ipaddress
import os
from pathlib import Path
import shutil
from urllib.parse import urlsplit
from uuid import uuid4

from aiohttp import web

from comfy_api.latest import io
import folder_paths
import nodes
from server import PromptServer


def output_directory_input():
    return io.String.Input("output_directory", display_name="保存目录", default="", optional=True,
                           tooltip="留空使用 ComfyUI 输出目录。可输入完整路径或点击「选择保存目录」。")


def save_destination(filename_prefix, output_directory):
    if not output_directory or not output_directory.strip():
        return folder_paths.get_output_directory(), filename_prefix
    directory = Path(output_directory.strip()).expanduser()
    if not directory.is_absolute():
        raise ValueError("请填写完整的保存目录，或留空使用 ComfyUI 的输出目录。")
    return str(directory.resolve()), os.path.basename(os.path.normpath(filename_prefix)) or "ComfyUI"


def image_preview(root, subfolder, filename):
    location = Path(root, subfolder, filename).resolve()
    try:
        relative = location.parent.relative_to(Path(folder_paths.get_output_directory()).resolve())
    except ValueError:
        subfolder = f"portrait_sharp_saved/{uuid4().hex}"
        preview = Path(folder_paths.get_temp_directory(), subfolder, filename)
        preview.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(location, preview)
        return {"filename": filename, "subfolder": subfolder, "type": "temp"}
    return {"filename": filename, "subfolder": "" if relative == Path(".") else relative.as_posix(), "type": "output"}


class PortraitSharpSaveImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PortraitSharpSaveImage", display_name="人物换视角 · 保存图像", category="3d/portrait",
            is_output_node=True,
            inputs=[io.Image.Input("images"), io.String.Input("filename_prefix", display_name="文件名前缀", default="ComfyUI"),
                    output_directory_input()],
            outputs=[io.Image.Output(display_name="images")],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
        )

    @classmethod
    def execute(cls, images, filename_prefix, output_directory=""):
        root, prefix = save_destination(filename_prefix, output_directory)
        saver = nodes.SaveImage()
        saver.output_dir = root
        saved = saver.save_images(images, prefix, cls.hidden.prompt, cls.hidden.extra_pnginfo)["ui"]["images"]
        items = [image_preview(root, item["subfolder"], item["filename"]) for item in saved]
        return io.NodeOutput(images, ui={"images": items})


def browse_directories(directory, default):
    path = Path(directory or default).expanduser()
    if not path.is_absolute():
        raise ValueError("请输入完整的目录路径。")
    path = path.resolve()
    with os.scandir(path) as entries:
        folders = sorted((entry.name for entry in entries if entry.is_dir(follow_symlinks=False)), key=str.casefold)
    drives = os.listdrives() if hasattr(os, "listdrives") else [path.anchor]
    return {
        "directory": str(path), "parent": str(path.parent) if path.parent != path else None,
        "folders": [{"name": name, "path": str(path / name)} for name in folders],
        "roots": drives, "default": default,
    }


@PromptServer.instance.routes.post("/portrait-sharp/output-directories")
async def output_directories(request):
    try:
        local = ipaddress.ip_address(request.remote).is_loopback
    except ValueError:
        local = False
    origin = request.headers.get("Origin")
    if (not local or request.headers.get("X-Portrait-Directory-Picker") != "1"
            or (origin is not None and urlsplit(origin).netloc != request.host)):
        return web.json_response({"error": "请在本机 ComfyUI 中打开目录选择器。"}, status=403)
    data = await request.json()
    directory = data.get("directory", "") if isinstance(data, dict) else None
    if not isinstance(directory, str) or "\0" in directory:
        return web.json_response({"error": "无效目录。"}, status=400)
    try:
        result = await asyncio.to_thread(browse_directories, directory.strip(), folder_paths.get_output_directory())
    except ValueError as error:
        return web.json_response({"error": str(error)}, status=400)
    except OSError:
        return web.json_response({"error": "无法打开这个文件夹，请检查路径或权限。"}, status=400)
    return web.json_response(result)
