# Troubleshooting

## Error Architecture

All errors in MetOrigin Splat are converted to a unified `AppError` type before reaching the user. Raw exceptions, stack traces, panics, or segmentation faults are never displayed as default user-facing error messages.

## Error Hierarchy

```
User errors            — incorrect input or configuration
Environment errors     — missing dependencies or drivers
Media errors           — unsupported or corrupted media files
Engine errors          — external engine failures
Filesystem errors      — permission, disk, path issues
System resource errors — low memory, disk, GPU resources
Internal errors        — unexpected bugs in the application
```

## Error Code Reference

| Range      | Category              |
| ---------- | --------------------- |
| 1000–1099  | Project & file errors |
| 1100–1199  | Media errors          |
| 1200–1299  | Disk & permissions    |
| 2000–2099  | FFmpeg errors         |
| 3000–3099  | COLMAP errors         |
| 4000–4099  | Brush errors          |
| 5000–5099  | GPU & hardware        |
| 9000–9099  | Internal errors       |

## Error Structure

```rust
pub struct AppError {
    pub code: String,
    pub category: ErrorCategory,
    pub title: String,
    pub user_message: String,
    pub technical_message: Option<String>,
    pub suggestions: Vec<String>,
    pub retryable: bool,
    pub log_path: Option<PathBuf>,
}
```

## Common Issues

### COLMAP Fails to Register Images

**Symptom**: Very few images registered (e.g., 4 out of 180).

**Possible Causes**:
1. Video motion is too fast or contains blur
2. Scene lacks sufficient texture
3. Adjacent frames have insufficient overlap
4. Scene contains many dynamic objects

**Suggestions**:
1. Use slower, more continuous camera movement
2. Reduce the frame extraction interval (more frames)
3. Ensure the subject is captured from multiple angles
4. Avoid highly reflective, transparent, or solid-color surfaces
5. Switch matching strategy (sequential → exhaustive for photos)

### FFmpeg Fails to Process Video

**Possible Causes**:
1. Corrupted or incomplete video file
2. Unsupported codec
3. Variable frame rate not handled
4. File path contains unusual characters

**Suggestions**:
1. Verify the video plays correctly in a media player
2. Try a different encoding (H.264 MP4 is most compatible)
3. Re-encode the video with standard settings

### Application Won't Start

**Possible Causes**:
1. Missing GPU driver (NVIDIA CUDA-compatible)
2. Missing Visual C++ Redistributable
3. Antivirus blocking the application

**Suggestions**:
1. Install/update your GPU driver
2. Install the latest Visual C++ Redistributable
3. Check antivirus quarantine

### Training Fails Silently

**Possible Causes**:
1. Insufficient GPU memory
2. Brush cannot read the COLMAP output format
3. Incompatible Brush version

**Suggestions**:
1. Try the "Fast" preset which uses lower resolution
2. Check the training logs in the project directory
3. Ensure the bundled Brush version matches the COLMAP output format

### Low Disk Space

The application checks available disk space before starting each stage. If space is insufficient:
- Clear the project cache
- Remove completed projects you no longer need
- Free up disk space on the system drive

## Logs

- Application logs are stored in each project's `logs/` directory
- Each pipeline stage has its own log file
- Technical details (stack traces, engine raw output) are only in log files, not in user-facing error messages
- Users can access detailed logs through the UI's "Show Logs" entry
