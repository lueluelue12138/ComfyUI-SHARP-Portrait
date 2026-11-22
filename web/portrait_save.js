import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const css = `
.ps-folder-dialog{width:min(680px,95vw);padding:16px;color:#eee;background:#222327;border:1px solid #50525b;border-radius:8px;font:14px system-ui}
.ps-folder-dialog::backdrop{background:#0009}
.ps-folder-dialog form{display:grid;gap:10px}
.ps-folder-dialog h2{font-size:17px;margin:0}
.ps-folder-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ps-folder-row input{flex:1;min-width:160px;padding:5px;color:#eee;background:#18191c;border:1px solid #565760;border-radius:4px}
.ps-folder-dialog button{background:#34363b;color:#eee;border:1px solid #575964;border-radius:4px;padding:5px 8px;cursor:pointer}
.ps-folder-dialog button:disabled{opacity:.5;cursor:default}
.ps-folder-dialog .ps-folder-confirm{background:#3b5bdb;border-color:#5370ec}
.ps-folder-list{min-height:100px;height:min(300px,45vh);overflow:auto;display:flex;flex-direction:column;gap:3px;padding:6px;background:#191a1d;border:1px solid #464850}
.ps-folder-list button{text-align:left;background:#292a2f}
.ps-folder-status{min-height:1.3em;color:#ccc}
.ps-folder-actions{justify-content:flex-end}
`;

function element(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
}

function button(label, callback, className = "") {
    const item = element("button", { type: "button", textContent: label, className });
    item.addEventListener("click", callback);
    return item;
}

function chooseDirectory(initial, selected) {
    if (document.querySelector(".ps-folder-dialog[open]")) return;
    if (!document.getElementById("portrait-sharp-folder-css")) {
        document.head.append(element("style", { id: "portrait-sharp-folder-css", textContent: css }));
    }
    const dialog = element("dialog", { className: "ps-folder-dialog" });
    dialog.setAttribute("aria-label", "选择保存目录");
    const form = element("form");
    const path = element("input", { type: "text", value: initial || "" });
    path.setAttribute("aria-label", "目录路径");
    const volumes = element("div", { className: "ps-folder-row" });
    const location = element("div", { className: "ps-folder-row" });
    const folders = element("div", { className: "ps-folder-list" });
    const status = element("div", { className: "ps-folder-status", role: "status" });
    const actions = element("div", { className: "ps-folder-row ps-folder-actions" });
    let current = null;
    let pending;
    const accept = directory => { selected(directory); dialog.close(); };
    const up = button("上一级", () => current?.parent && void load(current.parent));
    const select = button("选择此文件夹", () => current && accept(current.directory), "ps-folder-confirm");
    location.append(up, path, button("前往", () => void load(path.value)));
    actions.append(button("恢复默认目录", () => accept("")), button("取消", () => dialog.close()), select);
    form.append(element("h2", { textContent: "选择保存目录" }), volumes, location, folders, status, actions);
    form.addEventListener("submit", event => { event.preventDefault(); void load(path.value); });
    path.addEventListener("input", () => { select.disabled = !current || path.value !== current.directory; });
    dialog.append(form);
    dialog.addEventListener("close", () => { pending?.abort(); dialog.remove(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    void load(initial);

    async function load(directory) {
        pending?.abort();
        const controller = new AbortController();
        const previousText = path.value;
        pending = controller;
        current = null;
        up.disabled = select.disabled = true;
        folders.replaceChildren();
        status.textContent = "正在读取文件夹…";
        try {
            const reply = await api.fetchApi("/portrait-sharp/output-directories", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Portrait-Directory-Picker": "1" },
                body: JSON.stringify({ directory: directory || "" }),
                signal: controller.signal,
            });
            const data = await reply.json();
            if (controller.signal.aborted) return;
            if (!reply.ok) throw Error(data.error || "无法读取该目录。");
            current = data;
            if (path.value === previousText) path.value = data.directory;
            volumes.replaceChildren(button("默认输出目录", () => void load(data.default)),
                ...data.roots.map(root => button(root, () => void load(root))));
            folders.replaceChildren(...data.folders.map(folder => button(folder.name, () => void load(folder.path))));
            up.disabled = !data.parent;
            select.disabled = path.value !== data.directory;
            status.textContent = data.folders.length ? "" : "此处没有子文件夹。";
        } catch (error) {
            if (!controller.signal.aborted) status.textContent = error.message;
        }
    }
}

app.registerExtension({
    name: "portrait_sharp_repair.save_directory",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!["PortraitSharpSaveImage", "PortraitSharpDetailSave"].includes(nodeData.name)) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = created?.apply(this, arguments);
            const directory = this.widgets?.find(widget => widget.name === "output_directory");
            if (!directory) return result;
            const picker = this.addWidget("button", "选择保存目录", null, () => {
                chooseDirectory(directory.value, value => {
                    directory.value = value;
                    directory.callback?.(value);
                    this.graph?.change?.();
                    this.setDirtyCanvas?.(true, true);
                });
            }, { serialize: false });
            picker.serialize = false;
            return result;
        };
    },
});
