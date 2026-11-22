// SPDX-License-Identifier: MIT
// Copyright (c) 2026 aaljman
//
// Adapted from splat-repair-lora v1.1 for a two-stage ComfyUI workflow.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { SplatRenderer } from "./splat_renderer.js";
import { PortraitTrajectory } from "./portrait_trajectory.mjs";
import { PortraitDolly } from "./portrait_dolly.mjs";
import { focusPortraitNode } from "./portrait_focus.mjs";

const RATIOS = ["source", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"];
const CONTROLS_KEY = "portrait_sharp_view.controls";
const KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF", "KeyZ", "KeyC",
                      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

// 3x3 matrices are row-major arrays of 9.
const mul3 = (a, b) => [0, 1, 2].flatMap(i => [0, 1, 2].map(j => a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]));
const apply3 = (m, v) => [0, 1, 2].map(i => m[3 * i] * v[0] + m[3 * i + 1] * v[1] + m[3 * i + 2] * v[2]);
const transpose3 = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const add3 = (a, b, k = 1) => a.map((x, i) => x + b[i] * k);
const rotX = t => [1, 0, 0, 0, Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t)];
const rotY = t => [Math.cos(t), 0, Math.sin(t), 0, 1, 0, -Math.sin(t), 0, Math.cos(t)];
const rotZ = t => [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
const round = x => Math.round(x * 1e6) / 1e6;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// World-to-camera as 4x4 nested rows (for the node outputs) from a camera-to-world rotation and position.
function w2cRows(R, C) {
    const t = [0, 1, 2].map(i => -(R[i] * C[0] + R[3 + i] * C[1] + R[6 + i] * C[2]));
    return [[R[0], R[3], R[6], t[0]], [R[1], R[4], R[7], t[1]], [R[2], R[5], R[8], t[2]], [0, 0, 0, 1]].map(r => r.map(round));
}
const columnMajor = rows => new Float32Array([0, 1, 2, 3].flatMap(j => rows.map(r => r[j])));
// The numbers that decide the output; views restored from rounded JSON differ by ~1e-6.
const cameraKey = cam => [...cam.w2c.flat(), ...cam.K.flat(), cam.width, cam.height];
const sameCamera = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-4 * Math.max(1, Math.abs(b[i])));

const CSS = `
.gv-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:#0d0d0d;color:#cfcfcf;font:11px/1.35 system-ui,"Segoe UI",sans-serif;border-radius:6px;overflow:hidden}
.gv-root.gv-workspace{font-size:14px}
.gv-workspace .gv-bar button,.gv-workspace .gv-bar select{padding:5px 9px}
.gv-workspace .gv-bar input[type=range]{width:113px}
.gv-stage{position:relative;flex:1 1 0;min-height:0;overflow:hidden}
.gv-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;cursor:grab;touch-action:none}
.gv-stage canvas[hidden]{display:none}
.gv-stage canvas.gv-drag{cursor:grabbing}
.gv-stage canvas.gv-pick{cursor:crosshair}
.gv-frame{position:absolute;pointer-events:none;outline:1px solid rgba(255,255,255,.45);box-shadow:0 0 0 9999px rgba(0,0,0,.5);display:none}
.gv-overlay{position:absolute;pointer-events:none;opacity:0;display:none}
.gv-hud{position:absolute;left:8px;top:6px;right:112px;pointer-events:none;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gv-hud div{overflow:hidden;text-overflow:ellipsis}
.gv-dim{color:#8a8a8a}.gv-ok{color:#7fd1a8}.gv-warn{color:#e6b450}.gv-err{color:#ff7b72;white-space:normal}
.gv-info{position:absolute;right:6px;top:6px;width:22px;height:22px;border-radius:50%;border:1px solid #5a5a5a;background:rgba(20,20,20,.8);color:#ddd;font:italic 600 13px/20px Georgia,serif;cursor:pointer;padding:0}
.gv-info:hover{border-color:#8a8a8a}
.gv-expand{position:absolute;right:34px;top:6px;height:22px;padding:0 7px;border:1px solid #5a5a5a;border-radius:4px;background:rgba(20,20,20,.8);color:#eee;font:inherit;cursor:pointer}
.gv-expand:hover{border-color:#a0a0a0}
.gv-root:fullscreen{width:100%;height:100%;border-radius:0}
.gv-fullscreen-dialog{inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#0d0d0d}
.gv-fullscreen-dialog>.gv-root{border-radius:0}
.gv-root.gv-open .gv-info{background:#3b5bdb;border-color:#3b5bdb;color:#fff}
.gv-bar{display:none;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 8px;background:#1b1b1b;border-top:1px solid #2c2c2c}
.gv-root.gv-open .gv-bar{display:flex}
.gv-bar button{background:#333;color:#eee;border:1px solid #474747;border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}
.gv-bar button:hover{background:#3e3e3e}
.gv-bar button.gv-primary{background:#3b5bdb;border-color:#3b5bdb;color:#fff;font-weight:600}
.gv-bar button.gv-primary:hover{background:#4c6ef5}
.gv-bar button:disabled{opacity:.45;cursor:default}
.gv-bar label{display:inline-flex;align-items:center;gap:4px;color:#9a9a9a}
.gv-bar input[type=range]{width:84px;margin:0}
.gv-bar select{background:#262626;color:#ddd;border:1px solid #474747;border-radius:4px;font:inherit;padding:1px 4px}
.gv-camera-actions{display:flex;flex-wrap:wrap;align-items:center;gap:5px 8px;flex-basis:100%}
.gv-roll-controls{display:flex;align-items:center;gap:6px}
.gv-roll-controls input[type=range]{width:105px}
.gv-roll-controls input[type=number]{width:5em;background:#262626;color:#ddd;border:1px solid #474747;border-radius:4px;font:inherit;padding:2px 4px}
.gv-num{min-width:3.2em;color:#ccc;font-variant-numeric:tabular-nums}
.gv-help{flex-basis:100%;color:#8a8a8a}.gv-help b{color:#c4c4c4;font-weight:600}
.gv-trajectory{padding:6px 8px;display:grid;gap:6px;background:#202020;border-top:1px solid #383838}
.gv-trajectory[hidden]{display:none}
.gv-track-row{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.gv-track-row label{display:flex;align-items:center;gap:5px}
.gv-track-row input,.gv-track-row select,.gv-track-row button{color:#eee;background:#303030;border:1px solid #525252;border-radius:4px;padding:4px 7px;font:inherit}
.gv-track-row button{cursor:pointer}.gv-track-row button:disabled{opacity:.45;cursor:default}
.gv-track-row button.gv-primary{background:#3b5bdb;border-color:#3b5bdb;font-weight:600}
.gv-track-row input{width:4.8em}.gv-track-total{color:#b5c7fb;font-variant-numeric:tabular-nums}
.gv-track-status{min-height:1.3em;color:#b9b9b9;overflow-wrap:anywhere}
.gv-dolly{display:grid;gap:6px;padding:6px 8px;background:#202020;border-top:1px solid #383838}
.gv-dolly[hidden],.gv-root:not(.gv-open) .gv-dolly{display:none}
.gv-dolly-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.gv-dolly-row button{background:#333;color:#eee;border:1px solid #525252;border-radius:4px;padding:3px 7px;font:inherit;cursor:pointer}
.gv-dolly-row button:disabled{opacity:.45;cursor:default}
.gv-dolly-row input{width:120px;margin:0}
.gv-dolly-status{min-height:1.3em;color:#b9b9b9}
.gv-dolly-pin{position:absolute;width:12px;height:12px;transform:translate(-50%,-50%);border:1px solid #ffe49d;border-radius:50%;box-shadow:0 0 0 1px #141414}
.gv-orbit-pin{position:absolute;width:12px;height:12px;transform:translate(-50%,-50%);border:2px solid #78dfdf;border-radius:50%;box-shadow:0 0 0 1px #141414;pointer-events:none}
.gv-root:not(.gv-open) .gv-dolly-pin{display:none}
`;

function el(tag, cls, props = {}) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return Object.assign(e, props);
}

function readControlsOpen() {
    try { return localStorage.getItem(CONTROLS_KEY) !== "0"; } catch { return true; }
}

class Viewer {
    constructor(node, cameraWidget) {
        this.node = node;
        this.cameraWidget = cameraWidget;
        this.ply = null;          // info of the PLY shown (from the node's output)
        this.loading = null;      // promise of the current load
        this.base = null;         // the photo's camera
        this.view = null;         // { target, dist, yaw, pitch, roll, zoom }
        this.ratio = "source";
        this.held = new Set();
        this.raf = 0;
        this.sortSeq = 0;
        this.orbitPickSeq = 0;
        this.sortWaiters = new Map();
        this.loadWaiter = null;

        this.buildDom();
        this.resizeObserver = new ResizeObserver(() => this.invalidate());
        this.resizeObserver.observe(this.stage);
        this.restore();
    }

    buildDom() {
        if (!document.getElementById("portrait-sharp-view-css")) {
            document.head.append(el("style", "", { id: "portrait-sharp-view-css", textContent: CSS }));
        }
        this.root = el("div", "gv-root");
        this.stage = el("div", "gv-stage");
        this.canvas = el("canvas", "", { tabIndex: 0, hidden: true });
        this.frameBox = el("div", "gv-frame");
        this.orbitPin = el("span", "gv-orbit-pin", { hidden: true });
        this.hud = el("div", "gv-hud");
        this.hudFile = el("div", "gv-dim", { textContent: "先在左侧选图，再点下方「建高斯」。" });
        this.hudState = el("div");
        this.hud.append(this.hudFile, this.hudState);
        this.infoButton = el("button", "gv-info", { textContent: "i", title: "显示或隐藏相机工具" });
        this.expandButton = el("button", "gv-expand", { type: "button", textContent: "全屏预览" });
        this.expandButton.setAttribute("aria-pressed", "false");
        this.stage.append(this.canvas, this.frameBox, this.orbitPin, this.hud, this.infoButton, this.expandButton);

        const bar = el("div", "gv-bar");
        const build = el("button", "", { textContent: "① 建高斯", title: "只计算高斯并打开预览" });
        this.resetButton = el("button", "", { textContent: "复位", title: "回到原图机位", disabled: true });
        this.zoom = el("input", "", { type: "range", min: 0.2, max: 3, step: 0.01, value: 1, title: "调整焦距，不移动相机" });
        this.zoomText = el("span", "gv-num", { textContent: "1.00×" });
        const zoomLabel = el("label", "", { textContent: "焦距" });
        zoomLabel.append(this.zoom, this.zoomText);
        this.ratioSelect = el("select", "", { title: "选择输出画幅" });
        for (const r of RATIOS) this.ratioSelect.append(el("option", "", { value: r, textContent: r === "source" ? "原图" : r }));
        const ratioLabel = el("label", "", { textContent: "画幅" });
        ratioLabel.append(this.ratioSelect);
        this.setButton = el("button", "gv-primary", { textContent: "② 修复当前机位", title: "用当前取景生成修复图", disabled: true });
        this.previewToggle = el("button", "", { type: "button", textContent: "释放预览", hidden: true,
            title: "释放 3D 预览使用的内存和显存，保留当前机位与高斯文件" });
        this.releaseOnRepair = el("input", "", { type: "checkbox",
            title: "单张修复取景后，先释放 3D 预览再开始生图" });
        const releaseLabel = el("label", "", { textContent: "单张修复时释放预览" });
        releaseLabel.prepend(this.releaseOnRepair);
        this.detailButton = el("button", "", { textContent: "去精修", title: "定位到局部精修面板", hidden: true });
        this.compareButton = el("button", "", { textContent: "看新机位对比", hidden: true });
        const rollControls = el("div", "gv-roll-controls");
        const rollLabel = el("label", "", { textContent: "镜头转角" });
        this.rollSlider = el("input", "", { type: "range", min: -180, max: 180, step: 0.1, value: 0, disabled: true,
            title: "绕镜头轴旋转画面，可用来扶正地平线" });
        this.rollNumber = el("input", "", { type: "number", min: -180, max: 180, step: 0.1, value: 0, disabled: true,
            title: "镜头转角（度）" });
        this.rollNumber.setAttribute("aria-label", "镜头转角（度）");
        this.rollReset = el("button", "", { textContent: "转角归零", title: "只重置镜头转角", disabled: true });
        rollLabel.append(this.rollSlider);
        rollControls.append(rollLabel, this.rollNumber, el("span", "", { textContent: "°" }), this.rollReset);
        const help = el("div", "gv-help");
        help.textContent = "左键单击选旋转中心 · 拖动旋转 · 右键平移 · 滚轮推拉";
        const cameraActions = el("div", "gv-camera-actions");
        cameraActions.append(rollControls, this.previewToggle, releaseLabel, this.detailButton, this.compareButton);
        bar.append(build, this.resetButton, zoomLabel, ratioLabel, this.setButton, cameraActions, help);
        this.root.append(this.stage, bar);
        this.trajectory = new PortraitTrajectory(this, cameraActions);
        this.dolly = new PortraitDolly(this, cameraActions);
        this.root.classList.toggle("gv-open", readControlsOpen());

        this.expandButton.addEventListener("click", () => void this.toggleFullscreen());
        this.root.addEventListener("fullscreenchange", () => this.syncFullscreen());
        this.infoButton.addEventListener("click", () => {
            const open = this.root.classList.toggle("gv-open");
            if (!open && (this.dolly.picking || this.dolly.pending)) this.dolly.cancelPick();
            try { localStorage.setItem(CONTROLS_KEY, open ? "1" : "0"); } catch { /* storage blocked */ }
            this.invalidate();
        });
        build.addEventListener("click", () => this.buildSplat());
        this.resetButton.addEventListener("click", () => { this.trajectory.stopPlayback(); this.reset(); });
        this.setButton.addEventListener("click", () => this.repair());
        this.previewToggle.addEventListener("click", () => {
            if (this.previewReleased) {
                this.previewReleased = false;
                this.show(this.ply).catch(() => {});
            } else {
                this.releasePreview();
            }
        });
        this.releaseOnRepair.addEventListener("change", () => {
            this.node.properties ??= {};
            this.node.properties.portraitReleaseOnRepair = this.releaseOnRepair.checked;
            this.node.graph?.change?.();
        });
        this.detailButton.addEventListener("click", () => {
            const detail = this.node.graph?.getNodeById(this.node.properties?.portraitDetailPanel);
            if (["PortraitSharpDetailRegion", "PortraitSharpGHInput"].includes(detail?.type)) {
                void this.exitFullscreen().then(() => focusPortraitNode(detail));
            }
        });
        this.compareButton.addEventListener("click", () => {
            const compare = this.node.graph?.getNodeById(this.node.properties?.portraitBaseCompare);
            if (compare?.type === "ImageCompare") void this.exitFullscreen().then(() => focusPortraitNode(compare));
        });
        this.rollSlider.addEventListener("input", () => this.setRoll(this.rollSlider.valueAsNumber));
        this.rollNumber.addEventListener("change", () => this.setRoll(this.rollNumber.valueAsNumber));
        this.rollReset.addEventListener("click", () => this.setRoll(0));
        this.zoom.addEventListener("input", () => {
            if (!this.view) return;
            this.view.zoom = +this.zoom.value;
            this.changed();
        });
        this.ratioSelect.addEventListener("change", () => { this.ratio = this.ratioSelect.value; this.changed(); });
        this.bindInput();
    }

    syncFullscreen() {
        const expanded = document.fullscreenElement === this.root || !!this.fullscreenDialog?.open;
        this.expandButton.textContent = expanded ? "退出全屏" : "全屏预览";
        this.expandButton.setAttribute("aria-pressed", String(expanded));
        this.invalidate();
    }

    async exitFullscreen() {
        if (document.fullscreenElement === this.root) await document.exitFullscreen();
        if (this.fullscreenDialog?.open) this.fullscreenDialog.close();
    }

    async toggleFullscreen() {
        if (document.fullscreenElement === this.root || this.fullscreenDialog?.open) {
            await this.exitFullscreen();
            return;
        }
        if (document.fullscreenEnabled && this.root.requestFullscreen) {
            try {
                await this.root.requestFullscreen();
                return;
            } catch { /* The desktop host can restrict native fullscreen. */ }
        }
        if (!this.root.isConnected) return;
        const marker = document.createComment("portrait camera");
        this.root.before(marker);
        const dialog = el("dialog", "gv-fullscreen-dialog");
        dialog.setAttribute("aria-label", "3D 相机全屏预览");
        this.fullscreenDialog = dialog;
        dialog.addEventListener("close", () => {
            marker.replaceWith(this.root);
            dialog.remove();
            this.fullscreenDialog = null;
            this.syncFullscreen();
            if (this.root.isConnected) this.expandButton.focus({ preventScroll: true });
        }, { once: true });
        dialog.append(this.root);
        document.body.append(dialog);
        dialog.showModal();
        this.syncFullscreen();
    }

    bindInput() {
        const c = this.canvas;
        let drag = null;
        this.dragEvents = new AbortController();
        const capture = { capture: true, signal: this.dragEvents.signal };
        c.addEventListener("contextmenu", e => e.preventDefault());
        // Claim drags before Nodes 2.0 can forward their pointer events to the graph.
        window.addEventListener("pointerdown", e => {
            if (!this.previewReady || this.repairing || !this.display || drag || !e.composedPath().includes(c)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            c.focus({ preventScroll: true });
            this.trajectory.stopPlayback();
            if (e.button === 0 && this.dolly.picking) {
                this.dolly.pick(e);
                return;
            }
            const pan = e.button !== 0 || e.shiftKey;
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan, moved: pan };
            c.setPointerCapture(e.pointerId);
            c.classList.add("gv-drag");
        }, capture);
        window.addEventListener("pointermove", e => {
            if (!drag || e.pointerId !== drag.id) return;
            e.stopImmediatePropagation();
            if (this.repairing) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 4) return;
            drag.moved = true;
            drag.x = e.clientX;
            drag.y = e.clientY;
            const fine = e.altKey ? 0.1 : 1;
            if (drag.pan) {
                const { R } = this.pose();
                const perPx = this.view.dist / this.display.fx * (c.width / c.getBoundingClientRect().width);
                this.view.target = add3(this.view.target, apply3(R, [-dx, -dy, 0]), perPx * fine);
            } else {
                this.orbit(dx * 0.005 * fine, -dy * 0.005 * fine);
            }
            this.changed();
        }, capture);
        const end = e => {
            if (!drag || e.pointerId !== drag.id) return;
            e.stopImmediatePropagation();
            const click = !drag.moved && e.type === "pointerup" && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4;
            drag = null;
            c.classList.remove("gv-drag");
            if (click) this.pickOrbit(e);
        };
        window.addEventListener("pointerup", end, capture);
        window.addEventListener("pointercancel", end, capture);
        c.addEventListener("lostpointercapture", end);
        // Nodes 2.0 forwards wheel events in the graph's capture phase.
        window.addEventListener("wheel", e => {
            if (!this.previewReady || !e.composedPath().includes(c)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (this.repairing) return;
            this.trajectory.stopPlayback();
            const v = this.view, b = this.base;
            const step = (e.deltaMode === 1 ? 33 : 1) * e.deltaY * (e.shiftKey ? 0.0001 : 0.001);
            const minDist = b.depth * 0.02;
            if (step < 0 && v.dist <= minDist * 1.001) {
                // Already at the target: carry it forward so the camera keeps moving in.
                v.target = add3(v.target, apply3(this.pose().R, [0, 0, 1]), -step * b.depth);
            } else {
                v.dist = Math.max(minDist, v.dist * Math.exp(step));
            }
            this.changed();
        }, { ...capture, passive: false });
        c.addEventListener("keydown", e => {
            if (this.repairing) return;
            if (e.code === "Escape" && (this.dolly.picking || this.dolly.pending)) {
                this.dolly.cancelPick();
            } else if (e.code === "Enter") {
                this.repair();
            } else if (KEYS.has(e.code)) {
                this.held.add(e.code);
                this.invalidate();
            } else if (!e.code.startsWith("Shift")) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
        });
        c.addEventListener("keyup", e => {
            this.held.delete(e.code);
            if (KEYS.has(e.code)) e.stopPropagation();
        });
        c.addEventListener("blur", () => this.held.clear());
        this.fine = false;
        c.addEventListener("keydown", e => { this.fine = e.shiftKey; });
        c.addEventListener("keyup", e => { this.fine = e.shiftKey; });
    }

    get previewReady() {
        return !!(this.worker && this.renderer && this.view && !this.loadWaiter);
    }

    // --- camera ---

    pose(view = this.view) {
        const R = mul3(mul3(mul3(this.base.R, rotY(view.yaw)), rotX(view.pitch)), rotZ(view.roll));
        return { R, C: add3(view.target, apply3(R, [0, 0, 1]), -view.dist) };
    }

    orbit(yaw, pitch) {
        const view = this.view;
        const pivot = view.orbitPivot;
        const before = pivot && this.pose();
        view.yaw += yaw;
        view.pitch = clamp(view.pitch + pitch, -1.55, 1.55);
        if (!before) return;
        const { R } = this.pose();
        const offset = apply3(transpose3(before.R), add3(before.C, pivot, -1));
        const center = add3(pivot, apply3(R, offset));
        view.target = add3(center, apply3(R, [0, 0, 1]), view.dist);
    }

    pickRay(event) {
        const frame = this.frameBox.getBoundingClientRect();
        const rect = this.canvas.getBoundingClientRect();
        const u = (event.clientX - frame.left) / frame.width;
        const v = (event.clientY - frame.top) / frame.height;
        const lens = this.display;
        if (!lens || !(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
        const sx = this.canvas.width / rect.width / lens.fx;
        const sy = this.canvas.height / rect.height / lens.fy;
        const ray = [(event.clientX - rect.left) * sx - lens.cx / lens.fx,
                     (event.clientY - rect.top) * sy - lens.cy / lens.fy];
        return { u, v, ray, radius: [9 * sx, 9 * sy] };
    }

    pickOrbit(event) {
        if (!this.ply || this.loadWaiter) return;
        const hit = this.pickRay(event);
        if (!hit) return;
        const id = "orbit-" + (++this.orbitPickSeq);
        this.orbitPick = { id, ray: hit.ray, ...this.pose() };
        this.worker.postMessage({ type: "pick", id, camera: this.currentCamera().w2c, ray: hit.ray, radius: hit.radius });
    }

    orbitPicked({ id, depth }) {
        if (this.orbitPick?.id !== id) return;
        const { ray, R, C } = this.orbitPick;
        this.orbitPick = null;
        if (!Number.isFinite(depth) || depth <= 0.02) {
            this.setMessage("此处没有可用的高斯深度，请点击画面中的主体。", "gv-warn");
            return;
        }
        this.view.orbitPivot = add3(C, apply3(R, [...ray, 1]), depth);
        this.setMessage("已选旋转中心，拖动可绕该点取景。", "gv-ok");
        this.invalidate();
    }

    // The output image: the photo's frame cropped to the ratio, focal scaled by zoom.
    outputFrame(view = this.view, ratio = this.ratio) {
        const b = this.base;
        let w = b.width, h = b.height;
        if (ratio !== "source") {
            const [rw, rh] = ratio.split(":").map(Number);
            if (w / h > rw / rh) w = Math.round(h * rw / rh); else h = Math.round(w * rh / rw);
        }
        const z = view.zoom;
        return { w, h, fx: b.fx * z, fy: b.fy * z, cx: b.cx - (b.width - w) / 2, cy: b.cy - (b.height - h) / 2 };
    }

    currentCamera(view = this.view, ratio = this.ratio) {
        const f = this.outputFrame(view, ratio);
        const { R, C } = this.pose(view);
        return {
            w2c: w2cRows(R, C),
            K: [[f.fx, 0, f.cx], [0, f.fy, f.cy], [0, 0, 1]].map(r => r.map(round)),
            width: f.w,
            height: f.h,
            ratio,
            token: this.ply.token,
            view: Object.fromEntries(Object.entries(view).map(([k, v]) => [k, Array.isArray(v) ? v.map(round) : round(v)])),
        };
    }

    setBase(ply, stats) {
        const K = ply.intrinsics;
        let fx, fy, cx, cy, width, height;
        if (K && K[0][0] > 0 && K[0][2] > 0 && K[1][2] > 0) {
            [fx, fy, cx, cy] = [K[0][0], K[1][1], K[0][2], K[1][2]];
            [width, height] = [Math.round(2 * cx), Math.round(2 * cy)];
        } else {
            // No intrinsics: rebuild the photo's frustum from the splats, 1024 px on the long side.
            const aspect = stats.tanX / stats.tanY;
            [width, height] = aspect >= 1 ? [1024, Math.round(1024 / aspect)] : [Math.round(1024 * aspect), 1024];
            fx = fy = width / 2 / stats.tanX;
            [cx, cy] = [width / 2, height / 2];
        }
        const E = ply.extrinsics;
        const R = E ? [E[0][0], E[1][0], E[2][0], E[0][1], E[1][1], E[2][1], E[0][2], E[1][2], E[2][2]] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const C = E ? apply3(R, [-E[0][3], -E[1][3], -E[2][3]]) : [0, 0, 0];
        this.base = { R, C, fx, fy, cx, cy, width, height, depth: Math.max(0.05, stats.medianDepth) };
    }

    reset() {
        if (!this.base) return;
        const b = this.base;
        this.view = { target: add3(b.C, apply3(b.R, [0, 0, b.depth])), dist: b.depth, yaw: 0, pitch: 0, roll: 0, zoom: 1 };
        this.zoom.value = 1;
        this.clearCapture();
        this.message = null;
        this.changed();
    }

    setRoll(degrees) {
        if (!this.view) return;
        if (Number.isFinite(degrees)) {
            this.trajectory.stopPlayback();
            this.view.roll = clamp(degrees, -180, 180) * Math.PI / 180;
        }
        this.changed();
        this.rollNumber.value = this.rollSlider.value;
    }

    applyKeys(dt) {
        const v = this.view, h = this.held;
        const k = (this.fine ? 0.1 : 1) * dt;
        const axis = (plus, minus) => (h.has(plus) ? 1 : 0) - (h.has(minus) ? 1 : 0);
        const move = [axis("KeyD", "KeyA") + axis("ArrowRight", "ArrowLeft"), axis("ArrowDown", "ArrowUp"), axis("KeyW", "KeyS")];
        if (move.some(Boolean)) v.target = add3(v.target, apply3(this.pose().R, move), 0.5 * this.base.depth * k);
        const turn = axis("KeyE", "KeyQ"), look = axis("KeyR", "KeyF"), roll = axis("KeyC", "KeyZ");
        if (turn || look) {
            // Turn about the camera itself, not the target.
            const { C } = this.pose();
            v.yaw += turn * 1.0 * k;
            v.pitch = clamp(v.pitch + look * 1.0 * k, -1.55, 1.55);
            v.target = add3(C, apply3(this.pose().R, [0, 0, 1]), v.dist);
        }
        if (roll) v.roll += roll * 0.8 * k;
        this.changed();
    }

    changed({ preserveDolly = false } = {}) {
        this.orbitPick = null;
        if (!preserveDolly) this.dolly.cameraChanged();
        if (this.view) {
            const angle = this.view.roll * 180 / Math.PI;
            const degrees = angle >= -180 && angle <= 180 ? angle : ((angle + 180) % 360 + 360) % 360 - 180;
            this.rollSlider.value = (Math.round(degrees * 10) / 10).toString();
            if (document.activeElement !== this.rollNumber) this.rollNumber.value = this.rollSlider.value;
        }
        if (this.view && this.ply && this.stored && !sameCamera(cameraKey(this.currentCamera()), this.stored)) {
            this.clearCapture();
        }
        this.requestSort();
        this.invalidate();
    }

    storeCamera(value) {
        this.cameraWidget.value = value;
        this.cameraWidget.callback?.(value);
        this.node.setDirtyCanvas?.(true, true);
    }

    clearCapture() {
        this.stored = this.savedView = this.savedToken = null;
        this.capturedView = null;
        this.storeCamera("");
        this.syncPreviewControls();
    }

    async buildSplat() {
        if (this.trajectory.running || this.repairing) return;
        this.trajectory.stopPlayback();
        this.clearCapture();
        this.previewReleased = false;
        this.syncPreviewControls();
        this.setMessage("已请求建高斯，完成后可以拖动取景。", "gv-dim");
        await app.queuePrompt(0, 1, { queueNodeIds: [String(this.node.id)] });
    }

    async repair() {
        if (this.setButton.disabled || this.disposed) return;
        this.trajectory.stopPlayback();
        const cam = this.currentCamera();
        const [width, height] = this.outputDimensions(cam.width, cam.height);
        this.repairing = true;
        this.held.clear();
        this.trajectory.sync();
        this.dolly.sync();
        try {
            if (this.previewReady) {
                this.setMessage("正在从 3D 预览保存当前机位…", "gv-dim");
                cam.capture = await this.captureFrame(cam, width, height);
            } else {
                cam.capture = this.capturedView.capture;
            }
            if (this.disposed || this.ply?.token !== cam.token) return;
            this.stored = cameraKey(cam);
            this.capturedView = cam;
            this.storeCamera(JSON.stringify(cam));
            if (this.releaseOnRepair.checked && this.previewReady) this.releasePreview();
            this.setMessage(this.previewReleased ? "预览已释放，正在提交当前机位修复。" : "已锁定当前机位，正在提交修复。", "gv-ok");
            const baseOutputs = this.node.properties?.portraitBaseOutputs;
            const targets = baseOutputs?.filter(id => this.node.graph?.getNodeById(id)).map(String);
            await app.queuePrompt(0, 1, targets?.length ? { queueNodeIds: targets } : undefined);
        } catch (error) {
            if (!this.disposed) this.setMessage(`取景失败，${error.message}`, "gv-err");
        } finally {
            this.repairing = false;
            if (!this.disposed) {
                this.trajectory.sync();
                this.dolly.sync();
                this.requestSort();
            }
        }
    }

    outputDimensions(width, height, edge = Number(this.node.widgets?.find(w => w.name === "long_edge")?.value ?? 1280)) {
        const scale = edge / Math.max(width, height);
        return [width, height].map(value => Math.max(64, Math.round(value * scale / 32) * 32));
    }

    async captureFrame(cam, width, height) {
        if (!this.previewReady) throw new Error("请先恢复 3D 预览。");
        const renderer = this.renderer;
        if (Math.max(width, height) > renderer.maxSize) throw new Error("尺寸超出当前显卡的取景限制。");
        await this.sortNow(cam.w2c);
        if (this.renderer !== renderer) throw new Error("取景时预览已关闭或切换。");
        const sx = width / cam.width, sy = height / cam.height;
        const k = cam.K;
        const pixels = renderer.capture(columnMajor(cam.w2c), [k[0][0] * sx, k[1][1] * sy, k[0][2] * sx, k[1][2] * sy], width, height);
        const scratch = document.createElement("canvas");
        scratch.width = width;
        scratch.height = height;
        scratch.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), width, height), 0, 0);
        const blob = await new Promise(resolve => scratch.toBlob(resolve, "image/png"));
        scratch.width = scratch.height = 1;
        if (!blob) throw new Error("无法保存当前机位的 PNG。");
        const upload = new FormData();
        upload.append("image", blob, `${crypto.randomUUID()}.png`);
        upload.append("type", "temp");
        upload.append("subfolder", "portrait_sharp_views");
        const response = await api.fetchApi("/upload/image", { method: "POST", body: upload });
        if (!response.ok) throw new Error(`保存临时取景图失败 (${response.status})。`);
        return (await response.json()).name;
    }

    // Read the camera saved in the workflow; its view is applied when the PLY loads.
    restore() {
        try {
            const cam = this.cameraWidget?.value ? JSON.parse(this.cameraWidget.value) : null;
            this.stored = cam ? cameraKey(cam) : null;
            this.capturedView = cam?.capture ? cam : null;
            this.savedView = cam?.view ?? null;
            this.savedToken = cam?.token ?? null;
            this.ratio = RATIOS.includes(cam?.ratio) ? cam.ratio : "source";
            this.ratioSelect.value = this.ratio;
        } catch {
            this.stored = this.savedView = this.capturedView = null;
        }
        if (this.savedView && this.base && this.ply?.token === this.savedToken) {
            this.view = { ...this.savedView };
            this.zoom.value = this.view.zoom;
            this.changed();
        }
    }

    // --- loading, sorting, drawing ---

    syncPreviewControls() {
        const ready = this.previewReady;
        const busy = this.trajectory?.running || this.repairing;
        const captured = this.previewReleased && this.view && this.stored &&
            this.capturedView?.token === this.ply?.token && sameCamera(cameraKey(this.currentCamera()), this.stored);
        this.previewToggle.hidden = !this.ply;
        this.previewToggle.disabled = !!busy;
        this.previewToggle.textContent = this.previewReleased ? "恢复预览" : "释放预览";
        this.releaseOnRepair.disabled = !!busy;
        this.setButton.disabled = !!busy || !(ready || captured);
        this.resetButton.disabled = this.zoom.disabled = this.ratioSelect.disabled =
            this.rollSlider.disabled = this.rollNumber.disabled = this.rollReset.disabled = !ready || !!this.repairing;
    }

    clearPreview() {
        this.trajectory.stopPlayback();
        this.held.clear();
        this.lastT = 0;
        this.display = this.orbitPick = null;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.loadWaiter?.reject(new Error("3D 预览已关闭或切换。"));
        this.loadWaiter = this.loading = null;
        for (const waiter of this.sortWaiters.values()) waiter.reject(new Error("3D 预览已关闭或切换。"));
        this.sortWaiters.clear();
        this.sorting = this.sortAgain = false;
        this.worker?.terminate();
        this.worker = null;
        this.dragEvents?.abort();
        this.renderer?.dispose();
        this.renderer = null;
        this.frameBox.style.display = "none";
        this.orbitPin.hidden = true;
        // A lost WebGL context stays associated with its canvas. A restore gets a fresh canvas.
        if (!this.canvas.hidden || this.dragEvents) {
            const canvas = el("canvas", "", { tabIndex: 0, hidden: true });
            this.canvas.replaceWith(canvas);
            this.canvas = canvas;
        }
        this.dragEvents = null;
    }

    releasePreview() {
        this.previewReleased = true;
        this.clearPreview();
        this.dolly.cancelPick();
        this.hudFile.className = "gv-dim";
        this.hudFile.textContent = "3D 预览已释放";
        this.message = null;
        clearTimeout(this.messageTimer);
        this.updateState();
        this.trajectory.sync();
    }

    async show(info) {
        if (this.disposed) return;
        const sameModel = this.ply?.token === info.token;
        if (sameModel && this.loading) return this.loading;
        if (!sameModel) {
            this.clearPreview();
            this.view = this.base = null;
            this.dolly.cameraChanged();
        }
        this.ply = info;
        if (this.previewReleased) {
            this.updateState();
            this.trajectory.sync();
            return;
        }
        const resume = sameModel && !!this.view;
        try {
            this.bindInput();
            this.renderer = new SplatRenderer(this.canvas);
            const worker = new Worker(new URL("./splat_worker.js", import.meta.url));
            this.worker = worker;
            worker.onmessage = e => { if (this.worker === worker) this.onWorker(e.data); };
        } catch (error) {
            this.releasePreview();
            this.setMessage(`无法启动 3D 预览，${error.message}`, "gv-err");
            return;
        }
        this.hudFile.className = "gv-dim";
        this.hudFile.textContent = "加载高斯预览中…";
        this.loading = new Promise((resolve, reject) => { this.loadWaiter = { resolve, reject, token: info.token, resume }; });
        this.dolly.sync();
        this.trajectory.sync();
        this.worker.postMessage({ type: "load", id: info.token, url: new URL(api.apiURL(info.url), location.href).href,
                                  base: info.extrinsics });
        return this.loading;
    }

    onWorker(m) {
        if (m.type === "loaded") {
            const waiter = this.loadWaiter;
            if (!waiter || m.id !== waiter.token) return;
            this.renderer?.setSplats(m.data, m.rows);
            this.loadWaiter = null;
            this.setBase(this.ply, m.stats);
            if (!waiter.resume && this.savedView && this.ply.token === this.savedToken) {
                this.view = { ...this.savedView };
                this.zoom.value = this.view.zoom;
            } else if (!waiter.resume) {
                this.reset();
            }
            this.canvas.hidden = false;
            this.hudFile.className = "";
            this.hudFile.textContent = `${this.ply.name} · ${(m.count / 1e6).toFixed(2)}M splats`;
            this.hudFile.title = `download ${m.ms.fetch.toFixed(0)} ms, parse ${m.ms.parse.toFixed(0)} ms`;
            this.changed({ preserveDolly: waiter.resume });
            waiter.resolve();
            this.trajectory.sync();
            this.dolly.sync();
        } else if (m.type === "picked") {
            if (typeof m.id === "string") this.orbitPicked(m);
            else this.dolly.picked(m);
        } else if (m.type === "sorted") {
            const w = this.sortWaiters.get(m.id);
            this.sortWaiters.delete(m.id);
            if (w) {
                this.renderer.setOrder(m.order, m.visible);
                this.sortMs = m.ms;
            }
            w?.resolve();
            this.invalidate();
        } else if (m.type === "error") {
            if (this.loadWaiter && m.id === this.loadWaiter.token) {
                this.releasePreview();
            } else {
                this.sortWaiters.get(m.id)?.reject(new Error(m.error));
                this.sortWaiters.delete(m.id);
            }
            this.setMessage(m.error, "gv-err");
        }
    }

    sortNow(rows) {
        const id = ++this.sortSeq;
        return new Promise((resolve, reject) => {
            this.sortWaiters.set(id, { resolve, reject });
            this.worker.postMessage({ type: "sort", id, row: rows[2] });
        });
    }

    // Keep at most one sort for the live view in flight; the latest view wins.
    requestSort() {
        if (!this.previewReady) return;
        if (this.sorting) { this.sortAgain = true; return; }
        this.sorting = true;
        const worker = this.worker;
        const { R, C } = this.pose();
        this.sortNow(w2cRows(R, C)).catch(() => {}).finally(() => {
            if (worker !== this.worker) return;
            this.sorting = false;
            if (this.sortAgain) { this.sortAgain = false; this.requestSort(); }
        });
    }

    invalidate() {
        if (this.previewReady && !this.raf) this.raf = requestAnimationFrame(t => this.frame(t));
    }

    frame(t) {
        this.raf = 0;
        if (this.held.size && this.view) {
            this.applyKeys(this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 1 / 60);
            this.lastT = t;
        } else {
            this.lastT = 0;
        }
        this.draw();
    }

    draw() {
        const c = this.canvas;
        const rect = c.getBoundingClientRect();
        if (!this.renderer || !this.view || rect.width < 2 || rect.height < 2) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1, 4096 / Math.max(rect.width, rect.height));
        const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
        if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];

        // Fit the output frame inside the canvas; draw the whole canvas with the same camera.
        const f = this.outputFrame();
        const k = Math.min(w / f.w, h / f.h);
        this.display = { fx: f.fx * k, fy: f.fy * k, cx: w / 2 + (f.cx - f.w / 2) * k, cy: h / 2 + (f.cy - f.h / 2) * k };
        const { R, C } = this.pose();
        this.renderer.draw(columnMajor(w2cRows(R, C)), [this.display.fx, this.display.fy, this.display.cx, this.display.cy], w, h);
        this.updateOrbitPin(R, C, w, h);

        const s = c.clientWidth / w;   // drawing-buffer px -> layout px
        const box = { left: `${(w - f.w * k) / 2 * s}px`, top: `${(h - f.h * k) / 2 * s}px`,
                      width: `${f.w * k * s}px`, height: `${f.h * k * s}px` };
        Object.assign(this.frameBox.style, box, { display: "block" });
        this.zoomText.textContent = `${this.view.zoom.toFixed(2)}×`;
        this.updateState();
    }

    updateOrbitPin(R, C, width, height) {
        this.orbitPin.hidden = true;
        if (!this.view.orbitPivot) return;
        const [x, y, depth] = apply3(transpose3(R), add3(this.view.orbitPivot, C, -1));
        if (depth <= 0.02) return;
        const { fx, fy, cx, cy } = this.display;
        const u = (cx + fx * x / depth) / width;
        const v = (cy + fy * y / depth) / height;
        if (u < 0 || u > 1 || v < 0 || v > 1) return;
        this.orbitPin.style.left = `${100 * u}%`;
        this.orbitPin.style.top = `${100 * v}%`;
        this.orbitPin.hidden = false;
    }

    updateState() {
        if (this.previewReleased && !this.message) {
            this.hudState.className = "gv-dim";
            this.hudState.textContent = "点「恢复预览」可继续取景。";
            return;
        }
        if (!this.view || this.message) return;
        const frame = this.outputFrame();
        const [width, height] = this.outputDimensions(frame.w, frame.h);
        const set = this.stored && sameCamera(cameraKey(this.currentCamera()), this.stored);
        this.hudState.className = set ? "gv-ok" : "gv-dim";
        this.hudState.textContent = `输出 ${width} × ${height} · ${set ? "已选机位" : "拖动取景后点②"}`;
    }

    setMessage(text, cls) {
        this.message = text;
        this.hudState.className = cls;
        this.hudState.textContent = text;
        clearTimeout(this.messageTimer);
        this.messageTimer = setTimeout(() => { this.message = null; this.updateState(); }, 6000);
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.messageTimer);
        this.clearPreview();
        this.trajectory.dispose();
        void this.exitFullscreen();
        this.resizeObserver.disconnect();
    }
}

app.registerExtension({
    name: "portrait_sharp_repair.viewer",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "PortraitSharpVisualCamera") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const camera = this.widgets?.find(w => w.name === "camera");
            if (camera) {
                camera.hidden = true;
                camera.computeSize = () => [0, -4];
            }
            this.gaussianViewer = new Viewer(this, camera);
            // hideInPanel: otherwise selecting the node moves the viewer into the properties panel,
            // which leaves it at the panel's width on the canvas (as ComfyUI's own 3D viewers do).
            const viewer = this.addDOMWidget("viewer", "gaussian_viewer", this.gaussianViewer.root,
                                             { serialize: false, hideInPanel: true, getMinHeight: () => 320 });
            viewer.serialize = false;
            const size = this.widgets?.find(w => w.name === "long_edge");
            if (size) {
                const callback = size.callback;
                size.callback = (...args) => {
                    callback?.apply(size, args);
                    if (this.gaussianViewer.stored) this.gaussianViewer.clearCapture();
                    this.gaussianViewer.invalidate();
                };
            }   // keep it out of widgets_values, or the saved camera is not restored

            this.setSize([Math.max(this.size[0], 560), Math.max(this.size[1], 520)]);
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            this.gaussianViewer?.restore();
            this.gaussianViewer?.trajectory.sync();
            if (this.gaussianViewer) {
                this.gaussianViewer.releaseOnRepair.checked = !!this.properties?.portraitReleaseOnRepair;
                this.gaussianViewer.detailButton.hidden = !this.properties?.portraitDetailPanel;
                this.gaussianViewer.compareButton.hidden = !this.properties?.portraitBaseCompare;
                this.gaussianViewer.root.classList.toggle("gv-workspace", !!this.properties?.portraitLargeControls);
            }
            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (output) {
            onExecuted?.apply(this, arguments);
            const info = output?.portrait_sharp_view?.[0];
            if (info) this.gaussianViewer?.show(info).catch(() => {});
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this.gaussianViewer?.dispose();
            return onRemoved?.apply(this, arguments);
        };
    },
});
