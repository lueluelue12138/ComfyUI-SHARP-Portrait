import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const STORE = "portraitSharpTrajectories";

function element(tag, props) {
    return Object.assign(document.createElement(tag), props);
}

function copyView({ target, dist, yaw, pitch, roll, zoom, orbitPivot }) {
    const view = { target: [...target], dist, yaw, pitch, roll, zoom };
    if (orbitPivot) view.orbitPivot = [...orbitPivot];
    return view;
}

function blend(a, b, t) {
    const eased = t * t * (3 - 2 * t);
    const lerp = (x, y) => x + eased * (y - x);
    const angle = (x, y) => x + eased * ((((y - x + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
    return {
        target: a.target.map((v, i) => lerp(v, b.target[i])),
        dist: lerp(a.dist, b.dist), pitch: lerp(a.pitch, b.pitch), zoom: lerp(a.zoom, b.zoom),
        yaw: angle(a.yaw, b.yaw), roll: angle(a.roll, b.roll),
    };
}

function* sample(views, between) {
    yield { view: views[0], keyframe: true };
    for (let i = 1; i < views.length; i++) {
        for (let j = 1; j <= between; j++) {
            yield { view: blend(views[i - 1], views[i], j / (between + 1)), keyframe: false };
        }
        yield { view: views[i], keyframe: true };
    }
}

function repairOutput(prompt, cameraId) {
    const dependsOnCamera = (id, seen = new Set()) => {
        if (id === cameraId) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return Object.values(prompt[id]?.inputs ?? {}).some(value =>
            Array.isArray(value) && typeof value[0] === "string" && dependsOnCamera(value[0], seen));
    };
    const saves = Object.values(prompt).filter(node => ["SaveImage", "PortraitSharpSaveImage"].includes(node.class_type) &&
        Array.isArray(node.inputs.images) && dependsOnCamera(node.inputs.images[0]));
    if (saves.length !== 1) throw new Error("请保留一条连接到当前相机的「保存图像」输出。");
    return saves[0].inputs.images;
}

async function waitForFrame(id, outputId, signal) {
    while (!signal.aborted) {
        const res = await api.fetchApi(`/history/${encodeURIComponent(id)}`, { signal });
        if (!res.ok) throw new Error(`无法读取任务状态 (${res.status})。`);
        const job = (await res.json())[id];
        if (job) {
            if (job.status?.status_str === "success" && job.outputs?.[outputId]?.images?.length === 1) return;
            const details = job.status?.messages?.find(([type]) => type === "execution_error");
            throw new Error(details?.[1]?.exception_message || "这一帧未生成图片，可能已被中断。");
        }
        await new Promise(resolve => setTimeout(resolve, 900));
    }
    signal.throwIfAborted();
}

export class PortraitTrajectory {
    constructor(viewer, toolbar) {
        this.viewer = viewer;
        this.activeFrame = 0;
        this.disposeController = new AbortController();
        this.panel = element("div", { className: "gv-trajectory", hidden: true });
        this.toggle = this.button("轨迹", () => this.setOpen(this.panel.hidden));
        this.toggle.title = "记录相机关键帧与批量导出";
        this.toggle.setAttribute("aria-expanded", "false");
        toolbar.append(this.toggle);
        this.list = element("select", { title: "选择并回看关键帧" });
        this.list.addEventListener("change", () => {
            this.activeFrame = Number(this.list.value);
            this.stopPlayback();
            this.setView(this.track.views[this.activeFrame]);
            this.sync();
        });
        this.add = this.button("＋ 记关键帧", () => this.edit("add"));
        this.replace = this.button("覆盖", () => this.edit("replace"));
        this.remove = this.button("删除", () => this.edit("remove"));
        this.earlier = this.button("←", () => this.reorder(-1));
        this.later = this.button("→", () => this.reorder(1));
        this.earlier.title = "把选中的关键帧提前";
        this.later.title = "把选中的关键帧推后";
        this.play = this.button("播放预览", () => this.playback ? this.stopPlayback() : this.preview());
        const editRow = element("div", { className: "gv-track-row" });
        editRow.append(this.add, this.list, this.earlier, this.later, this.replace, this.remove, this.play);

        this.between = element("input", { type: "number", min: 0, step: 1, value: 0 });
        const countLabel = element("label", { textContent: "每段补间" });
        countLabel.append(this.between);
        this.between.addEventListener("input", () => this.saveSettings());
        this.mode = element("select", { title: "轨迹出图方式" });
        this.mode.append(element("option", { value: "repair", textContent: "AI 修复" }),
                         element("option", { value: "preview", textContent: "高斯粗图" }));
        this.mode.addEventListener("change", () => this.saveSettings());
        this.export = this.button("导出序列", () => void this.exportFrames(), "gv-primary");
        this.stop = this.button("停止", () => {
            this.stopRequested = true;
            this.status.textContent = "当前帧完成后停止。";
        });
        this.total = element("span", { className: "gv-track-total" });
        const exportRow = element("div", { className: "gv-track-row" });
        exportRow.append(countLabel, this.mode, this.total, this.export, this.stop);
        this.status = element("div", { className: "gv-track-status", role: "status" });
        this.panel.append(editRow, exportRow, this.status);
        viewer.root.append(this.panel);
        this.sync();
    }

    button(label, click, className = "") {
        const button = element("button", { textContent: label, className, type: "button" });
        button.addEventListener("click", click);
        return button;
    }

    setOpen(open) {
        this.panel.hidden = !open;
        this.toggle.setAttribute("aria-expanded", String(open));
        if (open) this.viewer.dolly?.setOpen(false);
        this.sync();
        this.viewer.invalidate();
    }

    get track() {
        const v = this.viewer;
        return v.ply && v.node.properties?.[STORE]?.[v.ply.token];
    }

    save(changes) {
        const { node, ply } = this.viewer;
        if (!ply) return;
        node.properties ??= {};
        node.properties[STORE] = { ...node.properties[STORE],
            [ply.token]: { views: [], between: 0, mode: "repair", ...this.track, ...changes } };
        node.setDirtyCanvas?.(true, true);
        node.graph?.change?.();
        this.sync();
    }

    saveSettings() {
        const between = this.between.valueAsNumber;
        if (Number.isSafeInteger(between) && between >= 0) this.save({ between, mode: this.mode.value });
    }

    sync() {
        const v = this.viewer, track = this.track;
        const size = track?.views.length ?? 0;
        const ready = v.previewReady;
        this.activeFrame = Math.min(Math.max(0, this.activeFrame), Math.max(0, size - 1));
        this.list.replaceChildren(...(track?.views ?? []).map((_, i) =>
            element("option", { value: String(i), textContent: `关键帧 ${i + 1}` })));
        this.list.value = String(this.activeFrame);
        this.between.value = String(track?.between ?? 0);
        this.mode.value = track?.mode ?? "repair";
        this.total.textContent = `${size + Math.max(0, size - 1) * Number(this.between.value)} 张`;
        const locked = this.running || v.repairing || !ready;
        this.add.disabled = this.between.disabled = this.mode.disabled = locked;
        this.list.disabled = this.replace.disabled = this.remove.disabled = this.export.disabled = locked || !size;
        this.earlier.disabled = locked || this.activeFrame === 0;
        this.later.disabled = locked || this.activeFrame >= size - 1;
        this.play.disabled = locked || size < 2;
        this.stop.hidden = !this.running;
        v.syncPreviewControls();
    }

    edit(action) {
        this.stopPlayback();
        const views = [...(this.track?.views ?? [])];
        if (action === "add") {
            this.activeFrame = views.length;
            views.push(copyView(this.viewer.view));
        } else if (action === "replace") {
            views[this.activeFrame] = copyView(this.viewer.view);
        } else {
            views.splice(this.activeFrame, 1);
        }
        this.save({ views });
    }

    reorder(delta) {
        this.stopPlayback();
        const views = [...this.track.views];
        const next = this.activeFrame + delta;
        [views[next], views[this.activeFrame]] = [views[this.activeFrame], views[next]];
        this.activeFrame = next;
        this.save({ views });
    }

    setView(view) {
        this.viewer.view = copyView(view);
        this.viewer.zoom.value = view.zoom;
        this.viewer.changed();
    }

    preview() {
        const { views } = this.track;
        const started = performance.now();
        this.play.textContent = "停止预览";
        const draw = time => {
            const position = (time - started) / 1200;
            const i = Math.floor(position);
            if (i >= views.length - 1) {
                this.setView(views.at(-1));
                this.stopPlayback();
                return;
            }
            this.setView(blend(views[i], views[i + 1], position - i));
            this.playback = requestAnimationFrame(draw);
        };
        this.playback = requestAnimationFrame(draw);
    }

    stopPlayback() {
        cancelAnimationFrame(this.playback);
        this.playback = 0;
        this.play.textContent = "播放预览";
    }

    async exportFrames() {
        if (this.running || !this.track?.views.length) return;
        this.stopPlayback();
        const v = this.viewer, token = v.ply.token, ratio = v.ratio;
        const between = Number(this.between.value), mode = this.mode.value;
        if (!Number.isSafeInteger(between) || between < 0) {
            this.status.textContent = "每段补间请输入非负整数。";
            return;
        }
        const views = this.track.views.map(copyView);
        const count = views.length + (views.length - 1) * between;
        if (!Number.isSafeInteger(count)) { this.status.textContent = "请缩小补间数量。"; return; }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
        const sequence = `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
        this.save({ between, mode });
        this.running = true;
        this.stopRequested = false;
        this.sync();
        const signal = this.disposeController.signal;
        let finished = 0;
        try {
            const graph = await app.graphToPrompt();
            const cameraId = String(v.node.id);
            const input = mode === "repair" ? repairOutput(graph.output, cameraId) : [cameraId, 4];
            let outputId = "10000";
            while (graph.output[outputId]) outputId = String(Number(outputId) + 1);
            const first = v.currentCamera(views[0], ratio);
            const cameraNode = graph.output[cameraId];
            const [width, height] = v.outputDimensions(first.width, first.height, cameraNode.inputs.long_edge);
            for (const { view, keyframe } of sample(views, between)) {
                if (this.stopRequested) break;
                signal.throwIfAborted();
                if (v.ply?.token !== token) throw new Error("高斯已切换，轨迹导出已停止。");
                const index = finished + 1;
                this.status.textContent = `正在处理 ${index} / ${count}，请保持当前工作流打开。`;
                const camera = v.currentCamera(view, ratio);
                const capture = await v.captureFrame(camera, width, height);
                if (this.stopRequested) break;
                signal.throwIfAborted();
                const prompt = { ...graph.output, [cameraId]: { ...cameraNode, inputs: {
                    ...cameraNode.inputs, camera: JSON.stringify({ ...camera, capture }),
                } } };
                prompt[outputId] = { class_type: "PortraitSharpTrajectoryFrame", inputs: {
                    image: input, sequence, metadata: JSON.stringify({ index, count, keyframe, mode, camera, width, height }),
                }};
                const job = await api.queuePrompt(0, { output: prompt, workflow: graph.workflow }, { partialExecutionTargets: [outputId] });
                if (!job.prompt_id) throw new Error("未能提交轨迹帧任务。");
                await waitForFrame(job.prompt_id, outputId, signal);
                finished++;
            }
            this.status.textContent = `${this.stopRequested ? "已停止，" : ""}已导出 ${finished} / ${count} 张。目录：人物换视角/相机轨迹/${sequence}`;
        } catch (error) {
            if (!signal.aborted) this.status.textContent = `已保存 ${finished} 张。第 ${finished + 1} 帧失败：${error.message}`;
        } finally {
            this.running = false;
            if (!signal.aborted) { this.sync(); v.requestSort(); }
        }
    }

    dispose() {
        this.stopPlayback();
        this.disposeController.abort();
    }
}
