# User guide

[English](user-guide.md) | [简体中文](user-operation-flow.zh-CN.md)

MetOrigin Splat reconstructs videos and photos into 3D Gaussian Splatting scenes on your computer. Follow the [README](../README.md) and [development guide](development.md) to start the desktop app. The [current status](status.md) distinguishes the Windows legacy route, the opt-in Windows Brush 1 candidate and Apple Silicon macOS validation.

## Project center

The sidebar provides **Project Hub** and **Settings & Engines**. The project center displays projects as thumbnail cards, ordered by most recently opened. Use its toolbar to search by project name or path, open a project folder, or create a project. Select a card to enter its workspace. Card menus provide file-location, availability/relinking and deletion actions as applicable.

Use the window's sidebar control to hide or show navigation. In a compact window it opens a navigation dialog. Engine warnings in the project center link to settings; hardware and engine details are available there.

## Choose your language

Open **Settings & Engines** in the sidebar. **Interface language / Language** offers **Follow system**, **简体中文**, and **English**. Chinese system locales use Simplified Chinese; other system languages use English. The choice is saved on this device and takes effect immediately, including in the integrated SuperSplat editor. Switching languages preserves the current project, wizard input, running task and unsaved editor changes.

The language control remains available if engine settings cannot be loaded. Project names, paths and original engine logs retain their original text.

## Create a project

1. Select **New project**. Choose a video (MP4, MOV, AVI or MKV) or **Choose image folder** (JPG, JPEG or PNG).
2. For images, select any image in the desired folder. The app imports **the entire containing folder, including subfolders**, rather than only that image. At least three readable images are required.
3. Review the metadata, sampled thumbnails, warnings and blocking issues. Select **Analyze media** to continue to preflight.
4. Choose **Fast**, **Balanced** or **High Quality**. Each preset shows its frame count, resolution, iterations and estimated disk usage. Changing the preset runs preflight again. Fix blocking issues and select **Check again** before continuing.
5. Confirm the project name and destination, then choose **Create project only** or **Create and start reconstruction**. The app creates an ordinary folder using the project name and copies media into it; original files remain unchanged. Existing `.splat-project` folders can still be opened.

During copying, cancelling waits for the copy task to stop and cleans up the incomplete destination. Exiting a modified wizard asks whether to keep editing or discard the draft.

Expand **Capture tips** below the media analysis for shooting advice. Capture a static subject from overlapping viewpoints with slow, continuous motion. Avoid motion blur, moving objects and reflective or transparent surfaces. Preset values are defined in [presets](../presets/); higher quality settings cannot repair missing coverage.

## Follow reconstruction

The window header shows the project name and the actions available for its task state. The stage navigator shows four phases with their status and available progress:

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

Selecting a preprocessing stage shows frames; COLMAP stages show sparse points and cameras; training and export stages show Gaussian models or checkpoints. Selecting the current stage during reconstruction restores automatic tracking. A selected historical checkpoint stays selected as new training frames arrive.

Drag to orbit, use the mouse wheel to zoom and right-drag to pan. Focus the model canvas and press **R** to reset the view. While viewing a running training stage, the model updates automatically when the selected engine supports live preview. Leaving the project or hiding the page stops requesting new snapshots. Resource pressure can pause or release the preview while training continues.

The Windows legacy Brush 0.3 route uses the companion `brush_live.exe`. The opt-in Windows Brush 1 candidate and the patched Mac CLI implement live preview in their main executable. See [live preview](gaussian-live-preview.zh-CN.md) for route-specific setup.

After reconstruction completes, choose **Edit** in the window header to open the bundled SuperSplat workspace. **Save** replaces the project's `output/scene.ply` with the edited model after validation. **Back** returns to the results; leaving with unsaved changes asks for confirmation. Editing requires WebGPU support in the native WebView and graphics stack: WebView2 on Windows or the corresponding WKWebView environment on macOS. Platform acceptance limits are recorded in [current status](status.md).

Use **Open output folder** to access the final `output/scene.ply`. Checkpoints restore geometry, not the complete optimizer state. Review the checkpoint manager's impact preview before restoring or deleting a checkpoint.

## Projects, settings and troubleshooting

Search projects by name or path in the project center. Use **Relocate** for moved projects when offered. **Permanently delete project** in a project menu removes the project folder after an impact review and confirmation; safely stop an active task first.

**Settings & Engines** contains engine locations and versions, project defaults, storage limits, interface theme, language and diagnostic export. Missing measurements remain unknown rather than being shown as zero. Project preflight checks the selected destination's available space.

Review **View logs and activity** for user-facing events, errors and recovery guidance. **Export redacted diagnostics** includes project status, recent logs and engine/hardware information for troubleshooting. Original technical output is retained for diagnosis and is not machine-translated. See [Troubleshooting](troubleshooting.md) for engine setup and recovery details.

On macOS, closing a non-editing window hides it; use the application Quit command or ⌘Q to exit. Closing during editing first handles unsaved changes. On Windows, closing requests safe exit. Exit waits for task shutdown, child-process cleanup and project persistence; a failure keeps the application open with actionable feedback.
