# Demonstration media

The input portrait is the existing demonstration photograph used during local development of this workflow. The original photographer was not recorded in that development fixture. The repository claims no photographic authorship or new license over the input photograph.

The raw novel-view render and repaired image are an actual matched pair from the mask detail workflow's recorded local test. Both are 768 × 512. The repaired image was produced with Qwen Image 2.1 Turbo INT8 and the Splat Repair human LoRA. These are example results, not a multi-subject benchmark.

The detail result is the recorded conservative reference-refinement output used to populate the comparison panel. Source reference sampling in that test used a 1344 long-edge cap and a 663 × 1152 reference crop; smaller references retained their original pixel dimensions.

Screenshots were captured from the actual workflow running in an isolated local ComfyUI instance, with the existing SHARP PLY and recorded output images loaded for display. The overview shows the published mask detail graph. Camera keyframes in the trajectory screenshot illustrate the controls and do not imply a newly generated video.

PNG text metadata and embedded workflow histories were removed from the standalone example images before publishing. Pixel arrays were preserved. The comparison camera settings are in demo-settings.json. Screenshots and generated outputs are separate from the original input photograph and upstream example links.

The prompt optimization controls screenshot was added for v0.1.3. It shows the actual new workflow with the switch enabled and a recorded Qwen PE-I2I optimization of the same demonstration portrait and novel-view splat. The test verified that disabling the switch returned the exact original English prompt without running the optimizer. Enabling it produced an English repair description followed by the fixed camera, orientation and visibility constraints. The screenshot documents prompt execution and UI. A new image-quality comparison with optimization enabled was not generated for this release.

The four sharp-gui-*.webp images are user-supplied screenshots of Sharp GUI's spatial reframing, image editing, outpainting and editing-result interfaces, shared to introduce the companion project. Their original dimensions were 3345 × 1906. The three workbench screenshots were proportionally resized to 1600 × 912, and the result screenshot to 1920 × 1094, then encoded as WebP at quality 88. Screenshot metadata was omitted. The full frame and displayed content were retained. Together the published copies total approximately 232 KiB, compared with 7.97 MiB for the source PNGs. These screenshots illustrate Sharp GUI and its separate editing workflows.
