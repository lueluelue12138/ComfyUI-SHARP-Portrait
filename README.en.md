# ComfyUI SHARP Portrait

Interactive single-image portrait novel-view synthesis using Apple SHARP, Gaussian splats, Qwen-Image 2.1 Turbo INT8 and Splat Repair. [中文完整指南](README.md) · [Sharp GUI workbenches](#sharp-gui)

Build a splat from one photo, move the camera visually, then generate a repaired view. Masked refinement supports a second reference, uploaded close-ups, freehand masks, cropping and independent reference resolution. Additional controls include click-to-pivot, camera roll, full-screen preview, dolly zoom, keyframes and camera trajectory export.


## Results

The original photograph, the SHARP render at a changed camera pose, and the repaired image. The middle and right images use the same camera. Their native output size is 768 × 512. Click an image for full size.

| Input photograph | SHARP at the new viewpoint | Qwen + Splat Repair |
| :---: | :---: | :---: |
| ![Input portrait](docs/images/input-portrait.png) | ![Raw Gaussian render with missing edge coverage](docs/images/novel-view-splat.png) | ![Repaired image at the same viewpoint](docs/images/novel-view-repaired.png) |

Unobserved details are inferred. Facial structure, clothing and background can change.

## Workflow interface

The horizontal workspace provides the input, 3D camera, view comparison, reference refinement and final comparison, with sampling and model controls below.

![Actual mask detail workflow with recorded test outputs loaded](docs/images/workflow-overview.png)

### Camera and trajectory

![Interactive Gaussian camera with orbit, roll and preview release controls](docs/images/camera-controls.png)

![Camera keyframes and interpolated image sequence export](docs/images/camera-trajectory.png)

### Masked reference refinement

Paint the target on the left and upload, crop or mask the reference on the right. Reference sampling resolution is adjustable in the same panel.

![Reference refinement panel with crop and sampling controls](docs/images/detail-controls.png)

Screenshots show the actual interface populated with saved test results. [Media provenance and settings](docs/MEDIA.md).

<a id="sharp-gui"></a>

## Sharp GUI gallery workbenches

For a polished visual interface, or to submit jobs from phones, tablets and other computers on your LAN while your host handles generation, try **[Sharp GUI](https://github.com/lueluelue12138/sharp-gui)**. Its gallery workbenches cover spatial reframing, image editing and removal, and outpainting. This repository provides its original spatial reframing workflow. Click a screenshot to enlarge it.

| Spatial reframing | Image editing and removal | Outpainting |
| :---: | :---: | :---: |
| [![Sharp GUI spatial reframing with a 3D camera and perspective controls](docs/images/sharp-gui-spatial-reframing.webp)](docs/images/sharp-gui-spatial-reframing.webp) | [![Sharp GUI image editor with a reference photo and editing instructions](docs/images/sharp-gui-image-editing.webp)](docs/images/sharp-gui-image-editing.webp) | [![Sharp GUI outpainting with draggable canvas boundaries](docs/images/sharp-gui-outpainting.webp)](docs/images/sharp-gui-outpainting.webp) |

**Editing example** · A reference-guided outfit change, with the original on the left and the result on the right.

[![Sharp GUI before-and-after outfit editing result](docs/images/sharp-gui-edit-result.webp)](docs/images/sharp-gui-edit-result.webp)

**Installation and access**

The latest release may not provide all three workbenches ready to use. To try the latest features, choose either option.

- Download or clone the [latest source](https://github.com/lueluelue12138/sharp-gui/archive/refs/heads/main.zip), then build and deploy it using the [installation guide](https://github.com/lueluelue12138/sharp-gui/blob/main/docs/deployment.en.md).
- Download the [latest complete Windows portable package](https://github.com/lueluelue12138/sharp-gui/releases/latest), then try Settings → Update Center → Latest to update to the latest main-branch code.

Install the required ComfyUI custom nodes and models. If you get stuck, an AI assistant can help with the documentation and error messages.

## Install

Tested on Windows, Python 3.12, ComfyUI 0.42.5, frontend 1.55.18 and an RTX 5070 Ti Laptop GPU with 12 GB VRAM. Other platforms are unverified.

~~~shell
git clone https://github.com/lueluelue12138/ComfyUI-SHARP-Portrait.git custom_nodes/ComfyUI-SHARP-Portrait
python -m pip install -r custom_nodes/ComfyUI-SHARP-Portrait/requirements.txt
~~~

Use the ComfyUI Python executable. Move an older portrait_sharp_repair installation outside custom_nodes to avoid duplicate node IDs.

Install [Apple SHARP](https://github.com/apple-aiml-research/ml-sharp) in a separate CUDA environment, or reuse [sharp-gui](https://github.com/lueluelue12138/sharp-gui). Set the environment variable PORTRAIT_SHARP_PYTHON to its Python executable, then fully restart the launcher. If sharp is installed in ComfyUI's environment, the current executable can be used automatically.

Download exact model filenames from the [model table](README.md#模型). View synthesis needs the SHARP checkpoint, Qwen Turbo diffusion model, vision text encoder, VAE and Splat Repair human LoRA. Detail workflows additionally reference the Goohai consistency LoRA, obtained through its author's channels.

## Workflow

Choose a workflow and drop it onto ComfyUI. Both include the camera, repair, detail refinement and trajectory sequence.

| Workflow | Download | Use |
| --- | --- | --- |
| Mask detail | [SHARP_Portrait_Mask_Detail.json](workflows/SHARP_Portrait_Mask_Detail.json) | Original English repair prompt |
| Mask detail with optional prompt optimization | [SHARP_Portrait_Mask_Detail_Prompt_Optimize.json](workflows/SHARP_Portrait_Mask_Detail_Prompt_Optimize.json) | Switch between the original prompt and automatic two-image optimization below the camera |

Install this pack plus [Goohaitools-comfyui](https://github.com/goohai/Goohaitools-comfyui), [rgthree-comfy](https://github.com/rgthree/rgthree-comfy) and [ComfyUI-Easy-Use](https://github.com/yolain/ComfyUI-Easy-Use).

Drop a workflow JSON onto ComfyUI. Upload a photo, build its splat, move the camera, then repair the current view. Left-click selects the orbit pivot, left-drag orbits, right-drag pans and the wheel changes distance. Roll straightens the frame.

For refinement, paint the target on the left and upload or crop a reference on the right. Target crop dimensions set the output canvas. The reference is sampled independently with preserved aspect ratio. Default detail strength is 0.44. Reference detail sampling supports a maximum long edge of 2048. Main output and original-reference long edges support up to 2560.

Manual preview release destroys WebGL resources and terminates its worker while retaining the pose, pivot and keyframes. Published workflows enable release after single-frame capture by default. Restore reloads the same PLY. Sequence export retains the renderer for successive captures.

Record keyframes and set in-between samples to export raw splat renders or individually repaired views. Files and transforms.json are saved under output/人物换视角/相机轨迹. Image save nodes offer a local folder picker. Identical SHARP inputs reuse a temporary PLY. Different inputs accumulate files during a session, with ComfyUI responsible for startup and normal shutdown temp cleanup.

The setup checker lists missing node types and model selections without executing a graph.

~~~shell
python custom_nodes/ComfyUI-SHARP-Portrait/tools/check_setup.py
~~~

## Optional camera repair prompt optimization

In the new workflow, the switch below the camera defaults to off and uses the editable original English prompt. Turn it on before repairing the current view. Following SHARP GUI's spatial reconstruction flow, the Goohai Qwen PE node reads the current-view repair reference and source photo, requests short English descriptions of gaps and continuing textures, then appends fixed camera, head orientation and occlusion constraints. Source facial details are requested only when the face is visible in image 1. The default unconditional facial-reference sentence is replaced in optimization mode. Custom prompt text is retained.

The final prompt display below the switch is part of the repair chain and shows the full text used by the image model. The optimizer defaults to English, seed 666 and unloading after inference. Its instructions and model settings are in the lower prompt optimization group. The same switch applies to repaired trajectory frames, running optimization separately for each camera view and increasing export time. Image model and nine-step sampling settings follow the existing workflow.

![Prompt optimization switch, editable original English and the actual optimized prompt](docs/images/prompt-optimization-controls.png)

Use an updated Goohaitools-comfyui and its installation guidance for a llama-cpp-python build with Qwen35ChatHandler support. Put the GGUF files in models/LLM. The template preselects Qwen-Image-2.1-PE-I2I.Q5_K_S.gguf and Qwen-Image-2.1-PE-I2I.mmproj-bf16.gguf from the [I2I quantization repository](https://huggingface.co/prithivMLmods/Qwen-Image-2.1-PE-I2I-GGUF), plus Qwen-Image-2.1-PE-T2I.Q5_K_S.gguf from the [T2I quantization repository](https://huggingface.co/prithivMLmods/Qwen-Image-2.1-PE-T2I-GGUF). Both optimizers share the files. Two-image repair uses I2I and the vision projector. T2I is the node's fallback selection when no reference is present. ComfyUI may still validate model selections with the switch off. Select installed matching files or use the base workflow if these models are unavailable.

~~~shell
python custom_nodes/ComfyUI-SHARP-Portrait/tools/check_setup.py --workflow custom_nodes/ComfyUI-SHARP-Portrait/workflows/SHARP_Portrait_Mask_Detail_Prompt_Optimize.json
~~~

Compare the switch modes with a fixed camera and diffusion seed. The human-caption LoRA expects concise repair descriptions, and optimization quality depends on the input. Generated orientation and occlusion can still change. [Splat Repair caption guidance](https://github.com/aaljman/splat-repair-lora#caption-styles) · [Qwen PE multi-image documentation](https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I#multi-image-editing)

## Limits and attribution

Unseen surfaces are inferred. Identity and geometry can drift at large camera offsets. Reconstructed 3D quality and long high-resolution sequence memory behavior have not been systematically benchmarked. Keyframe interpolation interpolates cameras, and output images are generated separately.

The implementation adapts aaljman's GaussianViewer and prefill code, integrates SHARP and Splat Repair and follows the user's optimized Goohai Qwen detail workflow. [Third-party notices](THIRD_PARTY_NOTICES.md) describe sources and adapted components. The code is MIT-licensed. Model weights and dependencies retain their original terms.

[Upstream comparison examples](https://github.com/aaljman/splat-repair-lora#readme) belong to Splat Repair's authors. The README also includes this project’s own recorded test results. See [media notes](docs/MEDIA.md) for provenance and settings.
