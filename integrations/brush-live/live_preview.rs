// MetOrigin's demand-driven preview bridge for Brush 0.3.0 (Apache-2.0).
// A request acknowledges the last consumed frame. At most one new frame is
// produced per acknowledgement, with no queue of GPU snapshots or checkpoints.
use brush_render::{MainBackend, gaussian_splats::Splats};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

#[derive(Deserialize)]
struct Request {
    session_id: String,
    after_revision: u64,
    mode: String,
    expires_at_ms: u64,
}

#[derive(Serialize)]
struct Frame {
    protocol: u32,
    session_id: String,
    revision: u64,
    iteration: u32,
    splat_count: u32,
    relative_path: String,
    created_at_ms: u64,
}

pub struct LivePreview {
    directory: PathBuf,
    session_id: String,
    revision: u64,
    last_iter: u32,
}

impl LivePreview {
    pub fn from_env() -> Option<Self> {
        let directory = PathBuf::from(std::env::var_os("METORIGIN_BRUSH_LIVE_DIR")?);
        let session_id = std::env::var("METORIGIN_BRUSH_LIVE_SESSION").ok()?;
        Some(Self { directory, session_id, revision: 0, last_iter: 0 })
    }

    pub async fn update(&mut self, iter: u32, splats: Splats<MainBackend>) -> anyhow::Result<()> {
        let Ok(bytes) = std::fs::read(self.directory.join("request.json")) else { return Ok(()) };
        let Ok(request) = serde_json::from_slice::<Request>(&bytes) else { return Ok(()) };
        let interval = match request.mode.as_str() { "live" => 5, "low" => 100, _ => return Ok(()) };
        if request.session_id != self.session_id || request.expires_at_ms < now_ms()
            || request.after_revision != self.revision
            || (self.revision > 0 && iter.saturating_sub(self.last_iter) < interval) {
            return Ok(());
        }
        let splat_count = splats.num_splats();
        let bytes = encode_ply(splats).await?;
        let revision = self.revision + 1;
        let name = format!("frame-{revision}.ply");
        let temp = self.directory.join("frame.tmp");
        std::fs::write(&temp, bytes)?;
        std::fs::rename(&temp, self.directory.join(&name))?;
        let frame = Frame {
            protocol: 1, session_id: self.session_id.clone(), revision, iteration: iter,
            splat_count, relative_path: name, created_at_ms: now_ms(),
        };
        let temp = self.directory.join("latest.tmp");
        std::fs::write(&temp, serde_json::to_vec(&frame)?)?;
        std::fs::rename(temp, self.directory.join("latest.json"))?;
        self.revision = revision;
        self.last_iter = iter;
        // The reader has acknowledged revision - 1. Retain it during a swap.
        if revision > 2 {
            let _ = std::fs::remove_file(self.directory.join(format!("frame-{}.ply", revision - 2)));
        }
        log::info!("MetOrigin live preview: iteration {iter}, revision {revision}, {splat_count} splats");
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

// Preserve full float32 attributes and every SH coefficient. Avoid the upstream
// generic map serializer's per-vertex allocations on frequent live updates.
async fn encode_ply(splats: Splats<MainBackend>) -> anyhow::Result<Vec<u8>> {
    let splats = splats.with_normed_rotations();
    let count = splats.num_splats() as usize;
    let coeffs = splats.sh_coeffs.dims()[1];
    let means = splats.means.val().into_data_async().await.into_vec::<f32>().map_err(|e| anyhow::anyhow!("Reading means: {e:?}"))?;
    let scales = splats.log_scales.val().into_data_async().await.into_vec::<f32>().map_err(|e| anyhow::anyhow!("Reading scales: {e:?}"))?;
    let rotations = splats.rotation.val().into_data_async().await.into_vec::<f32>().map_err(|e| anyhow::anyhow!("Reading rotations: {e:?}"))?;
    let opacity = splats.raw_opacity.val().into_data_async().await.into_vec::<f32>().map_err(|e| anyhow::anyhow!("Reading opacity: {e:?}"))?;
    let sh = splats.sh_coeffs.val().into_data_async().await.into_vec::<f32>().map_err(|e| anyhow::anyhow!("Reading SH: {e:?}"))?;
    let mut header = format!("ply\nformat binary_little_endian 1.0\ncomment MetOrigin Brush live preview\ncomment Vertical axis: y\nelement vertex {count}\n");
    for name in ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity", "f_dc_0", "f_dc_1", "f_dc_2"] {
        header.push_str(&format!("property float {name}\n"));
    }
    for i in 0..3 * (coeffs - 1) { header.push_str(&format!("property float f_rest_{i}\n")); }
    header.push_str("end_header\n");
    let mut output = Vec::with_capacity(header.len() + count * (11 + 3 * coeffs) * 4);
    output.extend_from_slice(header.as_bytes());
    let mut push = |value: f32| output.extend_from_slice(&value.to_le_bytes());
    for i in 0..count {
        for value in &means[i * 3..i * 3 + 3] { push(*value); }
        for value in &scales[i * 3..i * 3 + 3] { push(*value); }
        for value in &rotations[i * 4..i * 4 + 4] { push(*value); }
        push(opacity[i]);
        for channel in 0..3 { push(sh[i * coeffs * 3 + channel]); }
        // Brush stores [splat, coefficient, RGB]; PLY stores channel-major SH.
        for channel in 0..3 {
            for coefficient in 1..coeffs { push(sh[i * coeffs * 3 + coefficient * 3 + channel]); }
        }
    }
    Ok(output)
}
