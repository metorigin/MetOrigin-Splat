# M0 public photo fixture

`james-sample-40.json` locks 40 unmodified JPEG photos (`IMG_1928.jpg` through
`IMG_1967.jpg`) from Mike R. James and Stuart Robson's sample-scale volcanic-bomb
photogrammetry dataset. The [versioned dataset](https://doi.org/10.6084/m9.figshare.9120020.v1)
is explicitly [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/), confirmed
by the [Figshare API record](https://api.figshare.com/v2/articles/9120020/versions/1).
Source photographs and generated models remain under ignored `target/`, outside
the source repository. The original images are never resized or rewritten.

Download the immutable Figshare file, then extract and validate the subset:

```sh
mkdir -p target/macos-m0/datasets/james-sample
curl -fL --continue-at - https://ndownloader.figshare.com/files/16636739 \
  -o target/macos-m0/datasets/james-sample/images.zip
python3 scripts/macos/prepare-smoke-fixture.py \
  --archive target/macos-m0/datasets/james-sample/images.zip \
  --output target/macos-m0/datasets/james-sample-40
```

The full archive is 611,535,084 bytes; the provider's MD5 is
`a62826fd45a89551a548897cf6b62b01`. The extraction script checks both, records its
SHA-256, validates ZIP CRC for every selected image, and records each image's
SHA-256. Use the checked-in manifest with the smoke harness so changed photos are
rejected. An existing extraction or experiment directory is never overwritten.
The complete archive was verified on 2026-10-27; its locked SHA-256 is
`b0d0995be5652d453fdb0d809a364ccd4a8a5040cae35fb6e748f0ff1783d2d1`.
All 40 image hashes from the initial partial extraction matched the complete
archive. The script now requires this SHA-256 as well as the provider MD5.

If the download is slow, a developer can read the selected entries once their
bytes have arrived. Fetch the final 65,536 bytes of the **same file** with
`curl -fL --range -65536 ... -o central-directory.bin` and pass
`--archive-tail central-directory.bin` to the extraction script. This mode checks
entry CRC and per-image SHA-256, rejects missing bytes, and records
`whole_archive_verification: pending_partial_download`. It must never be reported
as a successful whole-archive checksum check. The checked-in per-image hashes are
the accepted subset identity, independent of whether other photos are downloaded.

Run CPU SfM while Brush is building:

```sh
python3 scripts/macos/smoke-engines.py \
  --colmap target/macos-m0/colmap-install/bin/colmap \
  --colmap-build-info target/macos-m0/colmap-build/build-info.json \
  --sfm-only \
  --images target/macos-m0/datasets/james-sample-40/images \
  --fixture packaging/macos-arm64/fixtures/james-sample-40.json \
  --output target/macos-m0/smoke-incremental-01
```

For the complete experiment, omit `--sfm-only`, supply the built `--brush` and
`--brush-build-info` paths, and use a fresh output directory. Use
`--mapper global_mapper` to check that CPU path separately. `--measure-rss` wraps
each command in macOS `/usr/bin/time -l`; this needs permission to read process
metrics and fails visibly if that permission is unavailable. Its high-water RSS
is not total unified-memory consumption. System memory pressure/swap and native
viewer validation are separate measurements.

The smoke records exact command arrays, binary hashes bound to successful build
records, pinned commits, stage timings, reconstruction quality, normalized
dataset hashes, unchanged source hashes, complete Gaussian PLY validation and
actual Metal backend log evidence. Missing backend evidence produces a distinct
incomplete result. A 300-iteration smoke does not establish visual quality,
pause/resume, application integration, macOS 15 support, memory budgets, or a
self-contained installation. Unit tests and fixture preparation are not engine
execution evidence.

## Measured CPU baseline, 2026-10-27

The first incremental run used native arm64 COLMAP 4.1.0 at
`fa8e3b3ff591552855f8ad2806723c80f963f69c`, explicit CPU extraction/matching/BA,
four feature/matching/mapper threads, 1600-pixel feature extraction, and
960-pixel undistortion. It registered **40/40 images**, reconstructed **36,910
points**, and reported **0.520280 px** mean reprojection error. Wall times were
29.554 s extraction, 30.617 s exhaustive matching, 26.296 s incremental mapping,
and 21.599 s undistortion. Source hashes were unchanged. This first run did not
capture peak RSS; it is not a memory-budget result. Full logs and machine details
are local evidence in `target/macos-m0/`, not source artifacts.

A second run with `--measure-rss` also registered 40/40 images and reconstructed
36,910 points (0.520457 px mean error). Measurements from macOS `time -l`:

| Stage | Wall time | Child high-water RSS |
| --- | ---: | ---: |
| CPU features | 21.375 s | 2,268,332,032 bytes |
| CPU exhaustive matching | 23.051 s | 354,959,360 bytes |
| CPU incremental mapping | 23.789 s | 334,970,880 bytes |
| Undistortion | 15.469 s | 850,427,904 bytes |

These are independent-stage measurements from the current development host;
they do not establish a 16 GB system budget or explain scheduling differences
between runs. The second run also records hashes for the normalized training
dataset under `target/macos-m0/smoke-incremental-02-rss/evidence.json`.

The complete harness run in `target/macos-m0/smoke-complete-01` subsequently
completed CPU SfM, undistortion and 300 Brush iterations. Brush's recorded runtime
adapter was **Apple M1 Pro / IntegratedGpu / Metal**. The final SH0 PLY contained
43,988 Gaussians, was 2,463,829 bytes, and passed complete payload and finite-value
validation (SHA-256
`b7875824afdc213328b13aa75fcdf4eaaa3fe01cd4e773b3e0ef44bbfc435fa9`).
This run used the recorded `metorigin-macos.1` adapter-logging patch on pinned
Brush 1.0.0, not an assumption based on its `Auto` device selector. Engine identities
and patch hashes are retained in the run evidence. Training wall time was 6.111 s
on an already exercised development host; it is not a cold-start performance
guarantee. Native viewer and application acceptance remain separate.
