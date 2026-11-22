const css = `
.ps-reference-dialog{width:min(1120px,94vw);padding:14px;background:#202125;color:#eee;border:1px solid #54565f;border-radius:8px;font:14px system-ui}
.ps-reference-dialog::backdrop{background:#000a}
.ps-reference-dialog h2{font-size:19px;margin:0 0 10px}
.ps-reference-stage{height:min(69vh,780px);display:grid;grid-template-columns:minmax(0,1fr);place-items:center;background:#111216;overflow:hidden}
.ps-reference-frame{position:relative;max-width:100%;overflow:hidden;touch-action:none;cursor:crosshair}
.ps-reference-frame img{display:block;max-width:100%;max-height:min(69vh,780px);pointer-events:none}
.ps-reference-box{position:absolute;border:2px solid #ffce70;box-sizing:border-box;box-shadow:0 0 0 9999px #0007;pointer-events:none}
.ps-reference-footer{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:10px}
.ps-reference-footer output{margin-right:auto}
.ps-reference-dialog button{padding:6px 11px;border:1px solid #686a73;border-radius:4px;background:#31333a;color:#eee;cursor:pointer}
.ps-reference-dialog button:disabled{opacity:.5;cursor:default}
.ps-reference-dialog button.ps-crop-apply{background:#3d5bc4}
`;

export function positionCropBox(box, rect) {
    const [x, y, r, b] = rect;
    Object.assign(box.style, { left: x * 100 + "%", top: y * 100 + "%", width: (r-x) * 100 + "%", height: (b-y) * 100 + "%" });
}

export function openReferenceCrop(url, initial, apply) {
    if (!document.getElementById("ps-reference-crop-css")) {
        const style = document.createElement("style");
        style.id = "ps-reference-crop-css";
        style.textContent = css;
        document.head.append(style);
    }
    const dialog = document.createElement("dialog");
    dialog.className = "ps-reference-dialog";
    dialog.setAttribute("aria-label", "裁切参考图");
    dialog.innerHTML = `<h2>裁切参考图</h2><div class="ps-reference-stage"><div class="ps-reference-frame">
      <img alt="参考图"><span class="ps-reference-box" hidden></span>
    </div></div><div class="ps-reference-footer">
      <output>拖动框选要参考的区域</output><button data-clear>使用整张</button>
      <button data-cancel>取消</button><button data-apply class="ps-crop-apply" disabled>应用裁切</button>
    </div>`;
    const image = dialog.querySelector("img"), frame = dialog.querySelector(".ps-reference-frame");
    const box = dialog.querySelector(".ps-reference-box"), output = dialog.querySelector("output");
    const confirm = dialog.querySelector("[data-apply]");
    let selection = initial ? [...initial] : null, drag = null;
    const render = () => {
        const width = image.naturalWidth, height = image.naturalHeight;
        const valid = selection && (selection[2] - selection[0]) * width >= 8 && (selection[3] - selection[1]) * height >= 8;
        box.hidden = !selection;
        confirm.disabled = !valid;
        if (selection) positionCropBox(box, selection);
        if (!width || !height) return;
        output.textContent = selection
            ? "裁切 " + (Math.round(selection[2]*width)-Math.round(selection[0]*width)) + " × "
                + (Math.round(selection[3]*height)-Math.round(selection[1]*height)) + " px"
            : "原图 " + width + " × " + height + " px · 拖动框选";
    };
    const point = event => {
        const r = frame.getBoundingClientRect();
        return [(event.clientX-r.left)/r.width, (event.clientY-r.top)/r.height].map(x => Math.max(0, Math.min(1,x)));
    };
    frame.addEventListener("pointerdown", event => {
        if (event.button !== 0 || !image.naturalWidth) return;
        event.preventDefault();
        const [x,y] = point(event);
        drag = { id: event.pointerId, x, y };
        selection = [x,y,x,y];
        frame.setPointerCapture(event.pointerId);
        render();
    });
    const move = event => {
        if (drag?.id !== event.pointerId) return;
        const [x,y] = point(event);
        selection = [Math.min(x,drag.x),Math.min(y,drag.y),Math.max(x,drag.x),Math.max(y,drag.y)];
        render();
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", event => { move(event); drag = null; });
    frame.addEventListener("pointercancel", () => { drag = null; });
    image.addEventListener("load", render);
    image.addEventListener("error", () => { output.textContent = "参考图加载失败。"; });
    dialog.querySelector("[data-clear]").addEventListener("click", () => { apply(null); dialog.close(); });
    dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    confirm.addEventListener("click", () => { if (!confirm.disabled) { apply(selection); dialog.close(); } });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    image.src = url;
    document.body.append(dialog);
    dialog.showModal();
    render();
    return dialog;
}
