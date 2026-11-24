# Third-party notices and acknowledgements

## Apple SHARP

Single-image prediction uses Apple's sharp package through predict_sharp.py. The adapter calls create_predictor, predict_image, convert_focallength and save_ply. Apple source and model weights are installed separately.
- https://github.com/apple-aiml-research/ml-sharp
- https://github.com/apple-aiml-research/ml-sharp/blob/main/LICENSE
- https://github.com/apple-aiml-research/ml-sharp/blob/main/LICENSE_MODEL

## Splat Repair and GaussianViewer by aaljman

The browser Gaussian renderer, PLY parsing and depth sorting, initial interactive camera and push-pull hole prefill were adapted from the GaussianViewer component in Splat Repair v1.1. Changes add click-to-pivot, roll and dolly interaction, capture integration, trajectories, full-screen handling and explicit preview lifecycle management. Splat Repair human LoRA is downloaded separately.

The original MIT copyright and license are retained in LICENSE-splat-repair, source headers and the repository license.
- https://github.com/aaljman/splat-repair-lora
- https://github.com/aaljman/splat-repair-lora/tree/main/comfyui-gaussian-viewer

## Qwen and ComfyUI

Qwen provides the image model, vision encoder and VAE. ComfyUI provides execution, memory management, model loaders, samplers, Qwen reference caching and Gaussian types. Presets retain the local tuned workflow's nine-step custom sigma schedule.
- https://github.com/Comfy-Org/ComfyUI
- https://huggingface.co/Comfy-Org/Qwen-Image-2.1
- https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo

## Goohai and community workflows

The current mask detail graph follows the crop, scale, Qwen double-reference encode, consistency LoRA, sampling and crop-restore approach of the user's optimized Goohai Qwen 2.1 Turbo workflows. The bridge exposes masks, uploaded/cropped references and independent reference resolution to existing nodes.

Reference workflow names include “Qwen-2.1-移除、局部重绘_Turbo” and “Qwen2.1-turbo-9步-局部重绘-单图-双图”. Original external node code and original full graphs are obtained from their authors. The published main graph retains detail refinement. Goohai weights retain their own terms.
- https://github.com/goohai/Goohaitools-comfyui
- https://space.bilibili.com/1194488958

The extended graph also uses rgthree seed and EasyUse display nodes.
- https://github.com/rgthree/rgthree-comfy
- https://github.com/yolain/ComfyUI-Easy-Use

The companion SHARP GUI project informed the subprocess environment integration. The optional prompt optimization workflow also reuses its spatial reconstruction instructions and the composition of short English repair descriptions with viewpoint, orientation and occlusion constraints. It runs Goohai's QwenImagePromptOptimizer and Qwen's PE-I2I model through existing ComfyUI nodes.
- https://github.com/lueluelue12138/sharp-gui
- https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I
- https://huggingface.co/prithivMLmods/Qwen-Image-2.1-PE-I2I-GGUF

## Media

Linked upstream examples are the original author’s results. README screenshots and generated comparisons document this project’s actual local tests. The input is the existing project demonstration photograph; photographic authorship is not claimed by this repository. Image provenance and sampling metadata are recorded in docs/MEDIA.md. The MIT code license does not assign rights to the original photograph. Model weights, upstream media and external packages retain their own terms.
