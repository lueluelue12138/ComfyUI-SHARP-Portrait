import { app } from "../../scripts/app.js";

export function focusPortraitNode(node) {
    const canvas = app.canvas;
    if (!node || !canvas) return;
    const rect = canvas.canvas?.getBoundingClientRect();
    if (rect?.width > 100 && rect.height > 135) {
        const scale = Math.min(1.12, (rect.width - 76) / node.size[0], (rect.height - 112) / node.size[1]);
        canvas.ds.changeScale(scale, [rect.width / 2, rect.height / 2]);
    }
    canvas.centerOnNode(node);
}
