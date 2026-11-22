"""Run SHARP in the existing Sharp GUI Python environment and release its VRAM on exit."""

from pathlib import Path
import sys

import numpy as np
from PIL import Image
import torch

from sharp.cli.predict import predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils.gaussians import save_ply
from sharp.utils.io import convert_focallength


def predict(source, output, checkpoint, lens_mm):
    with Image.open(source) as photo:
        image = np.asarray(photo.convert("RGB"))
    height, width = image.shape[:2]
    focal = convert_focallength(width, height, float(lens_mm))
    device = torch.device("cuda")
    with torch.device(device):
        predictor = create_predictor(PredictorParams())
    state = torch.load(checkpoint, map_location="cpu", weights_only=True, mmap=True)
    predictor.load_state_dict(state)
    del state
    predictor.eval().to(device)
    result = predict_image(predictor, image, focal, device)
    save_ply(result, focal, (height, width), Path(output))


if __name__ == "__main__":
    predict(*sys.argv[1:])
