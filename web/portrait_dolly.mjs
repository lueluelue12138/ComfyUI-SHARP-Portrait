function element(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
}

export class PortraitDolly {
    constructor(viewer, toolbar) {
        this.viewer = viewer;
        this.nextId = 0;
        this.panel = element("div", { className: "gv-dolly", hidden: true });
        this.toggle = element("button", { type: "button", textContent: "透视联动", title: "希区柯克变焦" });
        this.toggle.setAttribute("aria-expanded", "false");
        toolbar.append(this.toggle);

        this.select = element("button", { type: "button", textContent: "选取主体" });
        this.slider = element("input", { type: "range", min: 50, max: 200, step: 1, value: 100 });
        this.slider.setAttribute("aria-label", "联动调整主体距离");
        this.reset = element("button", { type: "button", textContent: "恢复联动前" });
        this.status = element("div", { className: "gv-dolly-status", role: "status" });
        const controls = element("div", { className: "gv-dolly-row" });
        controls.append(this.select, element("span", { textContent: "推近・广角" }), this.slider,
            element("span", { textContent: "拉远・长焦" }), this.reset);
        this.panel.append(controls, this.status);
        viewer.root.append(this.panel);

        this.pin = element("span", { className: "gv-dolly-pin", hidden: true });
        viewer.frameBox.append(this.pin);
        this.toggle.addEventListener("click", () => this.setOpen(this.panel.hidden));
        this.select.addEventListener("click", () => {
            if (this.picking || this.pending) {
                this.cancelPick();
                return;
            }
            viewer.trajectory.stopPlayback();
            this.picking = true;
            this.sync("点一下预览中的人物，建议点脸或上身。");
        });
        this.slider.addEventListener("input", () => this.apply());
        this.reset.addEventListener("click", () => {
            this.slider.value = 100;
            this.apply();
        });
        this.sync();
    }

    setOpen(open) {
        this.panel.hidden = !open;
        this.toggle.setAttribute("aria-expanded", String(open));
        if (open) this.viewer.trajectory.setOpen(false);
        if (!open && (this.picking || this.pending)) this.cancelPick();
        this.sync();
        this.viewer.invalidate();
    }

    sync(message) {
        const ready = this.viewer.previewReady && !this.viewer.repairing;
        const selecting = !!(this.picking || this.pending);
        this.select.disabled = !ready;
        this.select.textContent = selecting ? "取消选取" : "选取主体";
        this.slider.disabled = !ready || !this.start || selecting;
        this.reset.disabled = this.slider.disabled || this.slider.valueAsNumber === 100;
        this.pin.hidden = this.panel.hidden || !this.start || selecting;
        this.viewer.canvas.classList.toggle("gv-pick", !!this.picking);
        this.status.textContent = message ?? (this.start
            ? `距离 ${this.slider.value}% · 焦距 ${this.viewer.view.zoom.toFixed(2)}×`
            : "选取主体后，推拉时会尽量保持它在画面里的大小。");
    }

    cancelPick() {
        this.picking = false;
        this.pending = null;
        this.sync();
    }

    cameraChanged() {
        if (this.start || this.picking || this.pending) {
            this.start = null;
            this.picking = false;
            this.pending = null;
            this.slider.value = 100;
            this.sync("机位已更新，可重新选取主体继续联动。");
        }
    }

    pick(event) {
        const hit = this.viewer.pickRay(event);
        if (!hit) {
            this.sync("请点在取景框内有画面的主体上。");
            return;
        }
        const { u, v, ray, radius } = hit;
        const id = ++this.nextId;
        this.pending = { id, u, v };
        this.picking = false;
        this.sync("正在查找主体深度…");
        this.viewer.worker.postMessage({ type: "pick", id, camera: this.viewer.currentCamera().w2c, ray, radius });
    }

    picked({ id, depth }) {
        if (this.pending?.id !== id) return;
        const { u, v } = this.pending;
        this.pending = null;
        if (!Number.isFinite(depth) || depth <= 0.02) {
            this.picking = true;
            this.sync("这里没找到稳定的深度，请点人物脸部或衣服。");
            return;
        }
        const { target, dist, zoom } = this.viewer.view;
        const { R, C } = this.viewer.pose();
        const pivot = C.map((c, i) => c + depth * R[i * 3 + 2]);
        this.start = { target: [...target], dist, zoom, depth, pivot };
        this.slider.min = Math.min(100, Math.max(50, Math.ceil(100 * Number(this.viewer.zoom.min) / zoom), Math.ceil(2 / depth)));
        this.slider.max = Math.max(100, Math.min(200, Math.floor(100 * Number(this.viewer.zoom.max) / zoom)));
        this.slider.value = 100;
        this.pin.style.left = `${100 * u}%`;
        this.pin.style.top = `${100 * v}%`;
        this.sync("已选定主体。拖动滑块观察背景透视变化。");
    }

    apply() {
        if (this.slider.disabled || !this.start) return;
        const { target, dist, zoom, depth, pivot } = this.start;
        const factor = this.slider.valueAsNumber / 100;
        const view = this.viewer.view;
        view.target = [...(factor === 1 ? target : pivot)];
        view.dist = factor === 1 ? dist : depth * factor;
        view.zoom = zoom * factor;
        this.viewer.zoom.value = view.zoom;
        this.viewer.changed({ preserveDolly: true });
        this.sync();
    }
}
