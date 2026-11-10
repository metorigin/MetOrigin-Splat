# Training provenance contract run, 2026-10-27

> Historical run only; current behavior is described in the [training contract](../../contracts/training-provenance.md), and current acceptance in [project status](../../status.md).

## Recorded development-host contract run

On 2026-10-27 the ignored Rust adapter test passed with the pinned Brush `1.0.0+metorigin-macos.3` executable SHA-256 `d73830ee5ad1b04d13ec3e2c5fca92be52a7589171b4432ef24d47ea5c6e7acf`. The final lint-clean fork patch SHA-256 was `f2e0853ba495e492fa5ebb890ed8d2a7886ce54752740daacbc67aff3c228cc8`. The test used the existing public James40 CPU reconstruction without rerunning SfM, copied it into Chinese-and-space paths, and invoked the application adapter and `splat-process` directly.

Actual settings were 300 iterations, SH0, resolution 960, image-cache budget 536,870,912 bytes, 300,000 maximum splats, four loader threads and zero LOD levels. Training logs explicitly identified Metal and four dataset-loader actor threads. The full test took 38.47 s including copying, hashing and the real compute probe; the Brush training process took 9.174 s. These are a warm development-host smoke observation, not a performance or peak-memory acceptance claim.

The validated final checkpoint contained 44,010 Gaussians, with SHA-256 `ce304c1097e6391c68715127ee300cc9857b8ce1aeeeeaa8441e39c3406630ef`. The test verified unchanged source inventory and executable bytes and no remaining temporary checkpoint. Local evidence is retained at `target/macos-m2/adapter-contract-02/evidence.json`, with structured command arguments and logs alongside. The earlier sandboxed attempt in `adapter-contract-01` failed to enumerate a Metal adapter during the compute probe; the test passed when run with the same real-GPU access required by the other Metal integration tests. Both attempts were retained.
