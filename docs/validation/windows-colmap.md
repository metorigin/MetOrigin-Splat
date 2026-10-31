# Windows COLMAP 4.1 acceptance

2026-10-30, Windows x64 / NVIDIA RTX 5080 Laptop GPU, driver 592.01,
16,303 MiB reported dedicated VRAM. These results cover this development host.

The official CUDA archive from the existing Windows lock was downloaded and its
321,463,068-byte length and SHA-256
`ccd2f8c5b44f3e0ce645170d6abad30ff763ede97eeb0e6e23af1993e624e64b`
verified. The executable reports COLMAP 4.1.0, source commit `fa8e3b3`, with CUDA;
binary SHA-256 is
`f1777b7daa886103a21ca7093ea1a6e57b62d1471e57d530cad8c690432b4866`.
The sibling 4.3 source repository was not modified or used on a project database.

The [fixed CC0 James40 fixture](../../packaging/macos-arm64/fixtures/README.md)
was checked by its per-image hashes before and after execution. Commands were
constructed by `ColmapAdapter` and run by `splat-process`, with four threads,
1,600-pixel SIFT extraction, exhaustive matching and 960-pixel undistortion.

The first experiment requested CUDA global positioning. Its log showed an
unannounced change of execution backend: the official archive's Ceres was built
without CUDA/cuDSS and fell back to CPU. This is **not CUDA GP acceptance**. Its
original evidence and a separate fallback audit remain in
`target/windows-colmap/smoke-cuda-01/`.

A second experiment explicitly selected CUDA feature extraction and matching,
CPU global positioning and CPU Ceres BA. The two SIFT GPU log markers and actual
populated features/verified matches were checked; the global mapping log had no
fallback warning. It registered **40/40** images, reconstructed **36,515** points
and reported **0.514089 px** mean reprojection error. Extraction took 24.786 s,
matching 35.518 s, mapping 70.332 s and undistortion 42.767 s. These are single-run
wall times, not performance guarantees or memory measurements. Source hashes
were unchanged. Evidence is retained in
`target/windows-colmap/smoke-cuda-cpu-gp-02/evidence.json`, with logs and the
normalized dataset alongside it.

The [pinned 4.1 SIFT implementation](https://github.com/colmap/colmap/blob/fa8e3b3ff591552855f8ad2806723c80f963f69c/src/colmap/feature/sift.cc)
selects CUDA by default in a CUDA build for these extraction options, and
compiles the matcher with its CUDA language/backend. This source check supports
the backend interpretation of the actual GPU extraction/matching results;
driver visibility alone was not used as computation evidence.

The ignored real-engine gate is reproducible with the three paths below:

```powershell
$env:METORIGIN_TEST_COLMAP = (Resolve-Path target/windows-colmap/archive/bin/colmap.exe).Path
$env:METORIGIN_TEST_JAMES_IMAGES = (Resolve-Path target/windows-fixtures/james40/images).Path
$env:METORIGIN_TEST_COLMAP_OUTPUT = Join-Path (Get-Location) 'target/windows-colmap/new-experiment'
cargo test -p splat-pipeline --test windows_colmap_cuda -- --ignored --nocapture
```

The output directory must be new. Full GPU training, videos, application UI,
resource limits, installer relocation and native macOS regression are separate
gates.

The 4.1 guard now also applies without an execution profile. An automated native
fixture reports incompatible 4.3 or unknown versions and would overwrite its
adjacent database on any invocation other than `-h`. All adapter constructors
and revalidation reject it before an unsafe command; a real old-style SQLite
camera table remains byte-for-byte unchanged. The same test accepts 4.1 and
checks failed help exit status. COLMAP's existing Mac CPU settings and Unix
command environment tests remain in the 144-test crate suite; this Windows run
does not claim native Mac execution.
