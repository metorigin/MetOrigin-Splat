# User guide

[English](user-guide.md) | [简体中文](user-operation-flow.zh-CN.md)

MetOrigin Splat reconstructs videos and photos into 3D Gaussian Splatting scenes on your computer. Follow the [README](../README.md) to run the Windows desktop app and prepare its engines.

## Choose your language

Open **Settings & Engines** in the sidebar. **Interface language / Language** offers **Follow system**, **简体中文**, and **English**. Chinese system locales use Simplified Chinese; other system languages use English. The choice is saved on this device and takes effect immediately, including in the integrated SuperSplat editor. Switching languages preserves the current project, wizard input, running task and unsaved editor changes.

The language control remains available if engine settings cannot be loaded. Project names, paths and original engine logs retain their original text.

## Create a project

1. Select **New project**. Choose a video (MP4, MOV, AVI or MKV) or **Choose image folder** (JPG, JPEG or PNG).
2. For images, select any image in the desired folder. The app imports **the entire containing folder, including subfolders**, rather than only that image. At least three readable images are required.
3. Review the metadata, sampled thumbnails, warnings and blocking issues. Select **Analyze media** to continue to preflight.
4. Choose **Fast**, **Balanced** or **High Quality**. Each preset shows its frame count, resolution, iterations and estimated disk usage. Changing the preset runs preflight again. Fix blocking issues and select **Check again** before continuing.
5. Confirm the project name and destination, then choose **Create project only** or **Create and start reconstruction**. The app copies media into a `.splat-project` folder; original files remain unchanged.

During copying, cancelling waits for the copy task to stop and cleans up the incomplete destination. Exiting a modified wizard asks whether to keep editing or discard the draft.

Capture a static subject from overlapping viewpoints with slow, continuous motion. Avoid motion blur, moving objects and reflective or transparent surfaces. Preset values are defined in [presets](../presets/); higher quality settings cannot repair missing coverage.

## Follow reconstruction

The workspace shows overall progress and four phases:

| Phase | Work performed |
| --- | --- |
| Preprocessing | Validate media, prepare frames and preprocess images |
| Feature extraction | Extract and match features, reconstruct cameras and check COLMAP quality |
| Training | Prepare the dataset, train with Brush and validate the model |
| Quality assessment | Export the model and generate final preview information |

Expand a phase to inspect its stages and outputs. Only one reconstruction task runs at a time. You can browse or prepare other projects while it runs; additional tasks are not automatically queued.

Use **Pause task**, **Cancel task**, **Continue** or **Retry task** as available. Actions that invalidate results first show what will be retained, removed and regenerated. If project state changes while that dialog is open, review the refreshed impact before confirming again. Recovery validates existing outputs; a progress percentage alone does not establish whether a stage can resume.

If COLMAP requires quality confirmation, review the measured checks before accepting the risk. A model that fails mandatory training requirements cannot proceed.

## Preview, edit and export

Selecting a preprocessing stage shows frames; COLMAP stages show sparse points and cameras; training and export stages show Gaussian models or checkpoints. **Follow current stage** restores automatic tracking. A selected historical checkpoint stays selected as new training frames arrive.

Drag to orbit, use the mouse wheel to zoom, right-drag to pan and press **R** to reset the view. **Live**, **Low frequency** and **Pause preview** control preview refresh. Pausing the preview does not pause training. Live models require the companion `brush_live.exe`; ordinary Brush supplies saved checkpoints.

After reconstruction completes, choose **Edit** to open the bundled SuperSplat workspace. **Save** replaces the project's `output/scene.ply` with the edited model after validation. **Back** returns to the results; leaving with unsaved changes asks for confirmation. Editing requires WebView2 and GPU drivers with WebGPU support.

Use **Open output folder** to access the final `output/scene.ply`. Checkpoints restore geometry, not the complete optimizer state. Review the checkpoint manager's impact preview before restoring or deleting a checkpoint.

## Projects, settings and troubleshooting

Search recent projects by name or path. Relocate a moved project when prompted. **Remove from recent projects** removes only the list entry; **Permanently delete project** removes the project folder after confirmation.

**Settings & Engines** contains engine locations and versions, project defaults, storage limits, interface theme, language and diagnostic export. Missing measurements remain unknown rather than being shown as zero. The Project Hub's free disk space refers to the application's drive; project preflight checks the selected destination.

Review **View logs and activity** for user-facing events, errors and recovery guidance. **Export redacted diagnostics** includes project status, recent logs and engine/hardware information for troubleshooting. Original technical output is retained for diagnosis and is not machine-translated. See [Troubleshooting](troubleshooting.md) for engine setup and recovery details.
