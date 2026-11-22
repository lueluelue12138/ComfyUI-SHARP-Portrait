import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { focusPortraitNode } from "./portrait_focus.mjs";
import { openReferenceCrop, positionCropBox } from "./portrait_reference_crop.mjs";

const MASK_FOLDER = "portrait_sharp_masks";
const REFERENCE_FOLDER = "portrait_sharp_references";
const EDIT_MODES = { refine: "细节精修", redraw: "局部重绘", remove: "移除物体" };
const EDIT_STRENGTH = { refine: 0.78, redraw: 1, remove: 1 };
const REFERENCE_EDGES = [768, 1024, 1344, 1536, 2048];
const styles = `
.ps-detail{display:flex;flex-direction:column;gap:8px;height:100%;width:100%;min-height:0;color:#ddd;background:#1b1b1d;padding:8px;box-sizing:border-box;border-radius:5px;font:12px system-ui}
.ps-detail-panes{display:grid;grid-template-columns:1fr 1fr;min-height:0;flex:1;gap:8px}
.ps-detail figure{display:flex;flex-direction:column;gap:5px;min-width:0;min-height:0;margin:0}
.ps-detail-stage{position:relative;flex:1;min-height:90px;background:#0c0c0d;border:1px solid #45454a;overflow:hidden}
.ps-detail-stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none}
.ps-detail-stage .ps-mask-overlay{opacity:.52}
.ps-detail-stage .ps-reference-box{position:absolute;z-index:1;border:2px solid #ffce70;box-sizing:border-box;box-shadow:0 0 0 9999px #0007;pointer-events:none}
.ps-reference-settings{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ps-reference-settings output{color:#bbb}
.ps-detail [hidden]{display:none}
.ps-detail-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.ps-detail button{color:#eee;background:#333;border:1px solid #555;border-radius:4px;padding:4px 8px;cursor:pointer;font:inherit}
.ps-detail button.ps-primary{background:#4a5ac7;border-color:#626ed3}
.ps-detail.ps-native{font-size:14px;padding:12px;gap:10px}
.ps-native button{padding:6px 10px}
.ps-detail button:disabled{opacity:.45;cursor:default}
.ps-detail select{background:#333;color:#eee;border:1px solid #555;border-radius:4px;padding:4px 8px;font:inherit}
.ps-edit-strength{display:flex;align-items:center;gap:4px}
.ps-edit-strength input{width:94px}
.ps-detail-status{overflow-wrap:anywhere;color:#bbb;min-height:1.4em}
.ps-detail-slider{display:flex;align-items:center;gap:4px}
.ps-detail-slider input{width:90px}
`;

function element(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
}

function mediaURL({ filename, subfolder, type }) {
    return api.apiURL("/view?" + new URLSearchParams({ filename, subfolder, type }));
}

async function upload(blob, filename, type, subfolder) {
    const form = new FormData();
    form.append("image", blob, filename);
    form.append("type", type);
    form.append("subfolder", subfolder);
    const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
    if (!response.ok) throw new Error("上传失败（" + response.status + "）。");
    const saved = await response.json();
    return { filename: saved.name, subfolder: saved.subfolder, type: saved.type };
}

function maskBlob(data) {
    const canvas = element("canvas", { width: data.width, height: data.height });
    canvas.getContext("2d").putImageData(data, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("无法保存遮罩。"));
    }, "image/png"));
}

async function uploadMask(data) {
    return upload(await maskBlob(data), crypto.randomUUID() + ".png", "temp", MASK_FOLDER);
}

function hasPaint(data) {
    for (let i = 3; i < data.data.length; i += 4) {
        if (data.data[i] > 5) return true;
    }
    return false;
}

function paintBounds({ data, width, height }) {
    let left = width, top = height, right = 0, bottom = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y*width+x)*4+3] <= 5) continue;
            left = Math.min(left,x);
            right = Math.max(right,x+1);
            top = Math.min(top,y);
            bottom = Math.max(bottom,y+1);
        }
    }
    return [left/width,top/height,right/width,bottom/height];
}

class MaskPane {
    constructor(label, onEdit, onClear) {
        this.frame = element("figure");
        this.stage = element("div", { className: "ps-detail-stage" });
        this.image = element("img", { alt: "" });
        this.refined = element("img", { alt: "精修后", hidden: true });
        this.overlay = element("img", { className: "ps-mask-overlay", alt: "", hidden: true });
        this.stage.append(this.image, this.refined, this.overlay);
        this.caption = element("figcaption", { textContent: label });
        this.actions = element("div", { className: "ps-detail-actions" });
        this.edit = element("button", { type: "button", textContent: "绘制遮罩" });
        this.clear = element("button", { type: "button", textContent: "清除遮罩" });
        this.edit.addEventListener("click", onEdit);
        this.clear.addEventListener("click", onClear);
        this.actions.append(this.edit, this.clear);
        this.frame.append(this.caption, this.stage, this.actions);
    }

    setMask(mask) {
        this.mask = mask;
        this.overlay.hidden = !mask;
        if (mask) this.overlay.src = mediaURL(mask.effective);
        else this.overlay.removeAttribute("src");
    }

    load(info) {
        if (info?.filename === this.info?.filename && info?.type === this.info?.type) return;
        this.info = info;
        if (info) this.image.src = mediaURL(info);
        else this.image.removeAttribute("src");
        this.refined.hidden = true;
        this.setMask(null);
    }
}

async function detailResult(id, nodeId, signal) {
    while (!signal.aborted) {
        const response = await api.fetchApi("/history/" + id, { signal });
        if (!response.ok) throw new Error("读取精修任务失败（" + response.status + "）。");
        const job = (await response.json())[id];
        if (job) {
            const result = job.outputs?.[nodeId]?.portrait_detail_result?.[0];
            if (job.status?.status_str === "success" && result) return result;
            const error = job.status?.messages?.find(([name]) => name === "execution_error");
            throw new Error(error?.[1]?.exception_message || "精修未生成图片。");
        }
        await new Promise(resolve => setTimeout(resolve, 900));
    }
}

class DetailEditor {
    constructor(node) {
        this.node = node;
        this.controller = new AbortController();
        if (!document.getElementById("portrait-sharp-detail-css")) {
            document.head.append(element("style", { id: "portrait-sharp-detail-css", textContent: styles }));
        }
        this.root = element("div", { className: node.type === "PortraitSharpGHInput" ? "ps-detail ps-native" : "ps-detail" });
        const panes = element("div", { className: "ps-detail-panes" });
        const makePane = label => {
            const pane = new MaskPane(label, () => void this.editMask(pane), () => {
                pane.setMask(null);
                this.sync();
            });
            return pane;
        };
        this.target = makePane("新机位成图 · 涂上要精修的部位");
        this.source = makePane("原图参考 · 可涂选参考部位");
        panes.append(this.target.frame, this.source.frame);

        this.cropOutline = element("span", { className: "ps-reference-box", hidden: true });
        this.source.stage.append(this.cropOutline);
        this.cropButton = element("button", { type: "button", textContent: "裁切参考图", hidden: true });
        this.cropReset = element("button", { type: "button", textContent: "取消裁切", hidden: true });
        this.cropButton.addEventListener("click", () => this.editReferenceCrop());
        this.cropReset.addEventListener("click", () => this.setReferenceCrop(null));
        this.source.actions.append(this.cropButton, this.cropReset);
        this.referenceSize = element("select");
        this.referenceSize.setAttribute("aria-label", "参考采样长边");
        for (const edge of REFERENCE_EDGES) this.referenceSize.append(element("option", { value: edge, textContent: edge + " px" }));
        this.referenceSize.value = "1536";
        this.referenceDetails = element("output");
        this.refSettings = element("div", { className: "ps-reference-settings", hidden: true });
        const sizeLabel = element("label", { className: "ps-edit-strength", textContent: "参考采样长边" });
        sizeLabel.append(this.referenceSize);
        this.refSettings.append(sizeLabel, this.referenceDetails);
        this.source.frame.append(this.refSettings);
        this.referenceSize.addEventListener("change", () => {
            this.node.properties.portraitReferenceEdge = Number(this.referenceSize.value);
            this.node.graph?.change?.();
            this.refreshReference();
        });
        this.source.image.addEventListener("load", () => this.refreshReference(), { signal: this.controller.signal });
        this.referenceResize = new ResizeObserver(() => this.refreshReference());
        this.referenceResize.observe(this.source.stage);

        this.file = element("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/bmp", hidden: true });
        this.upload = element("button", { type: "button", textContent: "上传特写" });
        this.original = element("button", { type: "button", textContent: "切回原图", hidden: true });
        this.source.actions.append(this.upload, this.original, this.file);
        this.upload.addEventListener("click", () => this.file.click());
        this.file.addEventListener("change", () => void this.uploadReference());
        this.original.addEventListener("click", () => {
            delete this.node.properties.portraitReferenceUpload;
            this.updateSource();
            this.node.graph?.change?.();
            this.setStatus("已切回输入原图。");
        });

        const actions = element("div", { className: "ps-detail-actions" });
        this.mode = element("select", { hidden: true });
        this.mode.setAttribute("aria-label", "遮罩编辑模式");
        for (const [value, name] of Object.entries(EDIT_MODES)) {
            this.mode.append(element("option", { value, textContent: name }));
        }
        this.strengthLabel = element("label", { className: "ps-edit-strength", textContent: "编辑幅度", hidden: true });
        this.strength = element("input", { type: "range", min: 0.3, max: 1, step: 0.01, value: EDIT_STRENGTH.refine });
        this.strengthValue = element("span");
        this.strengthLabel.append(this.strength, this.strengthValue);
        this.referenceLabel = element("label", { className: "ps-edit-strength", hidden: true });
        this.useReference = element("input", { type: "checkbox" });
        this.referenceLabel.append(this.useReference, document.createTextNode("重绘也参考右图"));
        this.useReference.addEventListener("change", () => {
            this.node.properties.portraitGHUseReference = this.useReference.checked;
            this.node.graph?.change?.();
        });
        this.mode.addEventListener("change", () => {
            this.strength.value = EDIT_STRENGTH[this.mode.value];
            this.storeMode();
            const tips = {
                refine: "细节精修会参考右图。默认提高清晰度并保持人物。",
                redraw: "局部重绘需要填写下面的重绘提示词。可勾选右图参考，也可上传特写。",
                remove: "涂满要移除的物体，点击执行即可补齐背景。",
            };
            this.setStatus(tips[this.mode.value]);
        });
        this.strength.addEventListener("input", () => this.sync());
        this.strength.addEventListener("change", () => this.storeMode());
        this.submit = element("button", { type: "button", className: "ps-primary", textContent: "③ 精修遮罩" });
        this.back = element("button", { type: "button", textContent: "返回 3D 相机", hidden: true });
        this.back.addEventListener("click", () => {
            const camera = this.node.graph?.getNodeById(this.node.properties?.portraitCameraNode);
            if (camera?.type === "PortraitSharpVisualCamera") focusPortraitNode(camera);
        });
        this.promptButton = element("button", { type: "button", textContent: "写重绘提示词", hidden: true });
        this.promptButton.addEventListener("click", () => {
            focusPortraitNode(this.node.graph?.getNodeById(this.node.properties?.portraitGHPrompt));
        });
        this.comparison = element("button", { type: "button", textContent: "查看前后对比", hidden: true, disabled: true });
        this.comparison.addEventListener("click", () => {
            const compare = this.node.graph?.getNodeById(this.node.properties?.portraitDetailCompare);
            if (compare?.type === "ImageCompare") focusPortraitNode(compare);
        });
        this.sliderLabel = element("label", { className: "ps-detail-slider", textContent: "修复前／后", hidden: true });
        const slider = element("input", { type: "range", min: 0, max: 100, value: 50, title: "拖动比较精修前后" });
        this.sliderLabel.append(slider);
        slider.addEventListener("input", () => {
            this.target.refined.style.clipPath = "inset(0 0 0 " + (100 - Number(slider.value)) + "%)";
        });

        this.status = element("div", { className: "ps-detail-status", role: "status", textContent: "先用 3D 相机生成一张基础图。" });
        actions.append(this.mode, this.strengthLabel, this.referenceLabel, this.submit, this.promptButton,
            this.back, this.comparison, this.sliderLabel);
        this.root.append(panes, actions, this.status);
        this.submit.addEventListener("click", () => void this.refine());
        this.sync();
    }

    sync() {
        const locked = !!(this.busy || this.working || this.activeEditor || this.cropDialog?.open);
        const mode = this.mode.hidden ? null : this.mode.value;
        this.mode.disabled = this.strength.disabled = locked;
        const native = this.node.type === "PortraitSharpGHInput";
        this.promptButton.hidden = !native || (!this.onlyRefine && mode !== "redraw");
        this.promptButton.textContent = this.onlyRefine ? "写精修提示词" : "写重绘提示词";
        this.strengthLabel.hidden = native || !mode || mode === "remove";
        this.referenceLabel.hidden = !native || mode !== "redraw" || this.source.info?.type === "input" || !!this.source.mask;
        this.useReference.disabled = locked;
        this.strengthValue.textContent = Number(this.strength.value).toFixed(2);
        this.submit.textContent = this.onlyRefine ? "③ 细节精修" : mode ? "③ " + EDIT_MODES[mode] : "③ 精修遮罩";
        this.submit.disabled = locked || !this.target.mask || !this.source.info;
        for (const pane of [this.target, this.source]) {
            pane.edit.disabled = locked || !pane.info;
            pane.clear.disabled = locked || !pane.mask;
        }
        this.upload.disabled = this.original.disabled = locked;
        this.cropButton.hidden = !this.onlyRefine;
        this.cropButton.disabled = locked || !this.source.info;
        this.cropReset.hidden = !this.onlyRefine || !this.referenceCrop;
        this.cropReset.disabled = locked;
        this.refSettings.hidden = !this.onlyRefine;
        this.referenceSize.disabled = locked;
        this.refreshReference();
    }

    storeMode() {
        this.node.properties.portraitEditMode = this.mode.value;
        this.node.properties.portraitEditDenoise = this.strength.valueAsNumber;
        this.node.graph?.change?.();
        this.sync();
    }

    configureModes() {
        const properties = this.node.properties;
        this.onlyRefine = this.node.type === "PortraitSharpGHInput" && !!properties?.portraitGHOnlyRefine;
        this.mode.hidden = this.onlyRefine || !properties?.portraitEditControls;
        const value = properties?.portraitEditMode;
        this.mode.value = Object.hasOwn(EDIT_MODES, value) ? value : "refine";
        this.strength.value = properties?.portraitEditDenoise ?? EDIT_STRENGTH[this.mode.value];
        this.useReference.checked = !!properties?.portraitGHUseReference;
        const edge = properties?.portraitReferenceEdge;
        this.referenceSize.value = REFERENCE_EDGES.includes(edge) ? edge : 1536;
        this.sync();
    }

    get referenceCrop() {
        const saved = this.node.properties?.portraitReferenceCrop;
        return saved?.filename === this.source.info?.filename && saved?.type === this.source.info?.type ? saved?.rect : null;
    }

    setReferenceCrop(rect) {
        if (rect) {
            this.node.properties.portraitReferenceCrop = {
                filename: this.source.info.filename, type: this.source.info.type, rect,
            };
        } else delete this.node.properties.portraitReferenceCrop;
        this.node.graph?.change?.();
        this.sync();
    }

    editReferenceCrop() {
        if (this.cropButton.disabled) return;
        const source = this.source.info;
        this.cropDialog = openReferenceCrop(mediaURL(source), this.referenceCrop, rect => {
            if (this.source.info === source) this.setReferenceCrop(rect);
        });
        this.cropDialog.addEventListener("close", () => { this.cropDialog = null; this.sync(); }, { once: true });
        this.sync();
    }

    refreshReference() {
        if (!this.onlyRefine) return;
        const width = this.source.info?.width || this.source.image.naturalWidth;
        const height = this.source.info?.height || this.source.image.naturalHeight;
        const crop = this.referenceCrop;
        this.cropOutline.hidden = !crop || !width || !height;
        if (!width || !height || !this.source.info) {
            this.referenceDetails.textContent = "";
            return;
        }
        if (crop) {
            const sw = this.source.stage.clientWidth, sh = this.source.stage.clientHeight;
            if (sw && sh) {
                const fit = Math.min(sw/width, sh/height);
                const w = fit*width/sw, h = fit*height/sh;
                const [x,y,r,b] = crop;
                positionCropBox(this.cropOutline, [(1-w)/2+x*w, (1-h)/2+y*h, (1-w)/2+r*w, (1-h)/2+b*h]);
            }
        }
        const paint = this.source.mask?.bounds;
        const [x,y,r,b] = crop || [0,0,1,1];
        const w = Math.round((paint ? Math.min(r,paint[2]) : r)*width) - Math.round((paint ? Math.max(x,paint[0]) : x)*width);
        const h = Math.round((paint ? Math.min(b,paint[3]) : b)*height) - Math.round((paint ? Math.max(y,paint[1]) : y)*height);
        if (w <= 0 || h <= 0) {
            this.referenceDetails.textContent = "右图遮罩与裁切框没有重叠";
            return;
        }
        const scale = Math.min(1, Number(this.referenceSize.value) / Math.max(w,h));
        const label = paint ? "遮罩选区约" : crop ? "裁切" : "原图";
        this.referenceDetails.textContent = label + " " + w + " × " + h + " px"
            + (scale < 1 ? " · 采样 " + Math.round(w*scale) + " × " + Math.round(h*scale) + " px" : " · 按原像素采样");
    }

    setStatus(text) {
        this.status.textContent = text;
        this.sync();
    }

    updateSource() {
        const filename = this.node.properties?.portraitReferenceUpload;
        const uploadInfo = typeof filename === "string" && /^[a-f0-9-]{36}\.(png|jpe?g|webp|bmp)$/.test(filename)
            ? { filename, subfolder: REFERENCE_FOLDER, type: "input" } : null;
        this.source.load(uploadInfo || this.originalInfo);
        this.source.caption.textContent = uploadInfo ? "补充特写 · 可涂选参考部位" : "原图参考 · 可涂选参考部位";
        this.original.hidden = !uploadInfo;
        this.sync();
    }

    async uploadReference() {
        const file = this.file.files?.[0];
        this.file.value = "";
        if (!file) return;
        const ext = file.name.toLowerCase().match(/\.(png|jpe?g|webp|bmp)$/)?.[0];
        if (!ext) {
            this.setStatus("请选择 PNG、JPEG、WebP 或 BMP 图片。");
            return;
        }
        this.working = true;
        this.setStatus("正在上传参考特写…");
        try {
            const saved = await upload(file, crypto.randomUUID() + ext, "input", REFERENCE_FOLDER);
            const img = element("img", { src: mediaURL(saved) });
            await img.decode();
            if (this.controller.signal.aborted) return;
            this.node.properties ??= {};
            this.node.properties.portraitReferenceUpload = saved.filename;
            this.updateSource();
            this.node.graph?.change?.();
            this.setStatus("已使用上传的特写。可涂选其中一部分，也可使用整张。");
        } catch (error) {
            this.setStatus("参考图读取失败，" + error.message);
        } finally {
            this.working = false;
            this.sync();
        }
    }

    async editMask(pane) {
        if (pane.edit.disabled) return;
        this.working = true;
        this.sync();
        try {
            const url = new URL("../Goohaitools-comfyui/js/goohai_mask_editor.js", import.meta.url);
            const { openGoohaiMaskEditor } = await import(url.href);
            if (this.controller.signal.aborted) return;
            const info = pane.info;
            this.activeEditor = openGoohaiMaskEditor({
                imageUrl: mediaURL(info),
                maskUrl: pane.mask ? mediaURL(pane.mask.raw) : null,
                state: pane.mask?.state,
                onMask: (effective, raw, state) => void this.saveMask(pane, info, effective, raw, state),
                onClose: () => { this.activeEditor = null; this.sync(); },
            });
        } catch (error) {
            this.setStatus("无法打开孤海遮罩编辑器，" + error.message);
        } finally {
            this.working = false;
            this.sync();
        }
    }

    async saveMask(pane, info, effective, raw, state) {
        this.working = true;
        this.setStatus("正在保存遮罩…");
        try {
            if (!hasPaint(effective)) {
                pane.setMask(null);
                this.setStatus("已清除遮罩。");
                return;
            }
            const effectiveFile = uploadMask(effective);
            const [mask, strokes] = await Promise.all([effectiveFile, state.fill || state.inverted ? uploadMask(raw) : effectiveFile]);
            if (pane.info !== info || this.controller.signal.aborted) return;
            pane.setMask({ effective: mask, raw: strokes, state, bounds: pane === this.source ? paintBounds(effective) : undefined });
            this.target.refined.hidden = true;
            this.sliderLabel.hidden = true;
            this.setStatus("遮罩已保存。");
        } catch (error) {
            this.setStatus("遮罩保存失败，" + error.message);
        } finally {
            this.working = false;
            this.sync();
        }
    }

    show({ target, source }) {
        if (this.target.info?.filename !== target.filename) {
            this.target.load(target);
            this.sliderLabel.hidden = true;
            this.comparison.disabled = true;
            this.setStatus("在新机位成图上绘制遮罩。右图可上传特写作为参考。");
        }
        this.originalInfo = source;
        this.updateSource();
    }

    async refine() {
        if (this.submit.disabled) return;
        const selection = {
            target: this.target.info.filename,
            source: this.source.info.filename,
            uploaded: this.source.info.type === "input",
            mask: this.target.mask.effective.filename,
            source_mask: this.source.mask?.effective.filename,
        };
        const native = this.node.type === "PortraitSharpGHInput";
        if (this.onlyRefine) {
            selection.edit_mode = "refine";
            selection.source_crop = this.referenceCrop;
            selection.reference_edge = Number(this.referenceSize.value);
        } else if (!this.mode.hidden) {
            selection.edit_mode = this.mode.value;
            if (native) selection.use_reference = this.useReference.checked;
            else selection.denoise = this.strength.valueAsNumber;
        }
        this.busy = true;
        this.setStatus(native ? "正在用孤海编辑流程生成，并融合遮罩接缝。" : "正在编辑遮罩，会保留遮罩外的画面。");
        try {
            const graph = await app.graphToPrompt();
            const regionId = String(this.node.id);
            const node = graph.output[regionId];
            const outputId = Object.keys(graph.output).find(id => {
                const output = graph.output[id];
                return output.class_type === "PortraitSharpDetailSave" && String(output.inputs.patch?.[0]) === regionId;
            });
            if (!node || !outputId) throw new Error("缺少精修输出连线。");
            if (native && selection.edit_mode !== "remove") {
                const promptNode = graph.output[String(this.node.properties?.portraitGHPrompt)];
                if (promptNode?.class_type !== "PrimitiveStringMultiline") throw new Error("缺少重绘提示词节点。");
                if (!promptNode.inputs.value?.trim()) {
                    if (selection.edit_mode === "redraw") throw new Error("请在下方「重绘提示词」写明要改成什么。");
                    promptNode.inputs.value = "精修遮罩区域内的自然纹理与清晰度。图 2 只提供纹理和细节，保持图 1 里人物的身份、脸部轮廓与长宽比、五官位置、姿态、打光和色彩。";
                }
            } else if (!native && selection.edit_mode === "redraw") {
                const editor = Object.values(graph.output).find(item => item.class_type === "PortraitSharpQwenCondition"
                    && String(item.inputs.edit_patch?.[0]) === regionId);
                if (!editor?.inputs.prompt?.trim()) throw new Error("请在下方「编辑指令」节点写明要改成什么。");
            }
            node.inputs = native ? { selection: JSON.stringify(selection) } : {
                selection: JSON.stringify(selection), detail_edge: node.inputs.detail_edge, feather: node.inputs.feather,
            };
            const compareId = String(this.node.properties?.portraitDetailCompare);
            const compare = graph.output[compareId]?.class_type === "ImageCompare";
            const targets = compare ? [outputId, compareId] : [outputId];
            const response = await api.queuePrompt(0, graph, { partialExecutionTargets: targets });
            if (!response.prompt_id) throw new Error("精修任务提交失败。");
            const result = await detailResult(response.prompt_id, outputId, this.controller.signal);
            if (result && this.target.info?.filename === result.before) {
                if (compare) this.comparison.disabled = false;
                else {
                    this.target.refined.src = mediaURL(result);
                    this.target.refined.style.clipPath = "inset(0 0 0 50%)";
                    this.target.refined.hidden = false;
                    this.target.overlay.hidden = true;
                    this.sliderLabel.hidden = false;
                }
                this.setStatus("编辑结果已保存，可查看前后对比。");
            }
        } catch (error) {
            if (!this.controller.signal.aborted) this.setStatus("精修失败，" + error.message);
        } finally {
            this.busy = false;
            this.sync();
        }
    }

    dispose() {
        this.controller.abort();
        this.referenceResize.disconnect();
        this.cropDialog?.close();
        this.activeEditor?.close();
    }
}

app.registerExtension({
    name: "portrait_sharp_repair.detail",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "PrimitiveStringMultiline") {
            const configured = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function () {
                const result = configured?.apply(this, arguments);
                if (this.properties?.portraitGHPanel && !this.widgets?.some(w => w.name === "返回遮罩编辑")) {
                    const back = this.addWidget("button", "返回遮罩编辑", null,
                        () => focusPortraitNode(this.graph?.getNodeById(this.properties.portraitGHPanel)), { serialize: false });
                    back.serialize = false;
                }
                return result;
            };
        }
        if (!["PortraitSharpDetailRegion", "PortraitSharpGHInput"].includes(nodeData.name)) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            const selection = this.widgets?.find(widget => widget.name === "selection");
            if (selection) { selection.hidden = true; selection.computeSize = () => [0, -4]; }
            this.detailEditor = new DetailEditor(this);
            this.addDOMWidget("detail_editor", "portrait_sharp_detail", this.detailEditor.root,
                { serialize: false, hideInPanel: true, getMinHeight: () => 275 }).serialize = false;
            return result;
        };
        const executed = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            executed?.apply(this, arguments);
            const images = output?.portrait_detail?.[0];
            if (images) this.detailEditor?.show(images);
        };
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const result = configured?.apply(this, arguments);
            const editor = this.detailEditor;
            if (editor) {
                editor.back.hidden = !this.properties?.portraitCameraNode;
                editor.comparison.hidden = !this.properties?.portraitDetailCompare;
                editor.configureModes();
                editor.updateSource();
            }
            return result;
        };
        const removed = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.detailEditor?.dispose();
            return removed?.apply(this, arguments);
        };
    },
});

