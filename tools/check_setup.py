"""Read ComfyUI node/model discovery without executing or changing a workflow."""
import argparse
import json
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--workflow", type=Path, default=Path(__file__).resolve().parents[1] / "workflows/01_basic_camera_repair.json")
    args = parser.parse_args()
    workflow = json.loads(args.workflow.read_text(encoding="utf-8-sig"))
    try:
        with urlopen(args.url.rstrip("/") + "/object_info", timeout=15) as response:
            schema = json.load(response)
    except URLError as error:
        parser.exit(2, f"Cannot reach ComfyUI at {args.url}: {error.reason}\n")
    missing = sorted({node["type"] for node in workflow["nodes"]} - schema.keys() - {"MarkdownNote", "Note", "Reroute"})
    print("Missing node types:", ", ".join(missing) if missing else "none")
    model_missing = []
    loaders = {"UNETLoader": "unet_name", "CLIPLoader": "clip_name", "VAELoader": "vae_name", "LoraLoaderModelOnly": "lora_name"}
    for node in workflow["nodes"]:
        kind = node["type"]
        if kind not in loaders or kind not in schema:
            continue
        name = node["widgets_values"][0]
        entry = schema[kind].get("input", {}).get("required", {}).get(loaders[kind], [])
        available = entry[0] if entry and isinstance(entry[0], list) else None
        if available is not None and name not in available:
            model_missing.append(name)
    print("Missing registered models:", ", ".join(sorted(set(model_missing))) if model_missing else "none detected")
    print("Check SHARP checkpoint and PORTRAIT_SHARP_PYTHON separately using the README.")
    return bool(missing or model_missing)

if __name__ == "__main__":
    raise SystemExit(main())
