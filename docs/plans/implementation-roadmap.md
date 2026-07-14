# Implementation Roadmap

Checkboxes were reconciled on 2026-07-14. A checked item has implementation and test or runtime evidence; partially implemented or unverified work remains unchecked. See `technical-spike.md` for the real FFmpeg, COLMAP, Brush, cancellation, recovery, and caching evidence.

## 12-Week Development Plan

### Week 0 — Project Setup

**Goal**: Establish open-source project foundation.

**Tasks**:
- [ ] Create `metorigin/splat` repository
- [ ] Determine license
- [ ] Create README, contributing guide, code of conduct, security policy
- [ ] Set up issue and PR templates
- [ ] Define branch strategy and versioning scheme
- [ ] Verify FFmpeg, COLMAP, Brush redistribution licenses
- [ ] Set up third-party license directory

**Deliverables**:
```
Repository is cloneable
Basic documentation complete
Empty CI pipeline runs
Licenses preliminarily confirmed
```

### Week 1 — Technical Spike

**Goal**: Manually verify the full pipeline end-to-end.

**Tasks**:
- [ ] Prepare 3 test datasets
- [x] Manual FFmpeg frame extraction
- [x] Manual COLMAP execution
- [x] Verify COLMAP output
- [x] Manual Brush execution
- [x] Verify output model
- [x] Record all commands, versions, errors, GPU/time/disk metrics

**Deliverables**:
```
docs/plans/technical-spike.md
scripts/manual-pipeline.ps1
Fixed test data description
Version compatibility record
```

### Week 2 — Repository & Domain Model

**Goal**: Complete basic code skeleton.

**Tasks**:
- [x] Initialize Rust workspace
- [x] Initialize Tauri application
- [x] Initialize React + TypeScript frontend
- [x] Create `splat-domain` crate
- [x] Create `splat-project` crate
- [x] Define Project schema
- [x] Define Stage and Status types
- [x] Define AppError
- [x] Add JSON Schema definitions
- [x] Add serialization tests
- [x] Add project migration interface

**Deliverables**:
```
Launchable empty desktop app
Project data model
project.schema.json
Basic unit tests
```

### Week 3 — Process Runner

**Goal**: Reliably launch and manage external programs.

**Tasks**:
- [x] Implement shell-free command execution
- [x] Implement stdout/stderr streaming
- [x] Implement log file writing
- [x] Implement exit code handling
- [x] Implement cancellation
- [x] Implement Windows process tree termination
- [x] Implement UTF-8 and system encoding compatibility
- [x] Implement event notification
- [x] Add fake process test utility
- [ ] Test CJK, space, and long paths

**Deliverables**:
```
splat-process crate
Process runner integration tests
Log file specification
```

### Week 4 — FFmpeg Integration

**Goal**: Video import and automatic frame extraction.

**Tasks**:
- [x] FFmpeg capability detection
- [x] FFprobe metadata reading
- [x] Video metadata parsing
- [x] Frame extraction plan calculation
- [x] Space estimation
- [x] Real-time progress parsing
- [x] Output frame validation
- [x] Rotation metadata handling
- [x] Failure error mapping
- [x] UI video import flow

**Deliverables**:
```
FFmpeg Adapter
Video media analysis
frames.json
Frame extraction UI
```

### Week 5 — COLMAP Features & Matching

**Goal**: Complete first half of COLMAP pipeline.

**Tasks**:
- [x] COLMAP version detection
- [x] Database creation
- [x] Feature Extraction
- [x] Sequential Matching
- [ ] Exhaustive Matching
- [x] Log parsing
- [x] Progress estimation
- [x] Input image validation
- [x] Database output verification
- [ ] Failure retry strategy

**Deliverables**:
```
COLMAP Adapter base version
Feature extraction & matching stages
Structured logs
```

### Week 6 — COLMAP Mapping & Validation

**Goal**: Output complete Sparse Reconstruction.

**Tasks**:
- [x] Mapper execution
- [x] Model directory detection
- [x] Best model selection
- [x] Registered image count parsing
- [x] Camera count parsing
- [x] Sparse point count parsing
- [x] Success threshold definition
- [x] Diagnostic report output
- [ ] Mapping retry support
- [ ] Re-execution after extraction parameter change

**Deliverables**:
```
Complete COLMAP pipeline
ColmapResult
Reconstruction quality report
```

### Week 7 — Brush Integration

**Goal**: Complete local training loop.

**Tasks**:
- [x] Pin Brush version
- [x] Implement Brush detection
- [x] Check data compatibility
- [x] Generate training configuration
- [x] Start training
- [x] Parse training progress
- [x] Detect output
- [x] Detect checkpoints
- [x] Training cancellation
- [x] Training resume verification
- [x] Output model validation

**Deliverables**:
```
Brush Adapter
TrainingRequest
Checkpoint Scanner
PLY output
```

### Week 8 — Full Pipeline & Recovery

**Goal**: One-click pipeline and failure recovery.

**Tasks**:
- [x] Implement Pipeline Orchestrator
- [x] Implement dependency resolution
- [x] Implement stage skipping
- [x] Implement stage retry
- [x] Implement crash recovery
- [x] Implement incomplete project detection on startup
- [x] Implement output integrity validation
- [x] Implement cancel-with-data-preservation
- [x] Implement project lock
- [x] Prevent concurrent runs on the same project

**Deliverables**:
```
Complete pipeline state machine
Recovery flow
Project lock mechanism
```

### Week 9 — Desktop UI Polish

**Goal**: Complete usable desktop product flow.

**Tasks**:
- [x] Home page
- [x] New project wizard
- [x] Recent projects
- [x] Media analysis page
- [x] Preset selection
- [x] Unified timeline training controls
- [x] Structured log and error workspace
- [x] Results and real PLY preview
- [x] Settings and diagnostics drawer
- [x] User-facing error prompts
- [x] Loading / Empty / Error states
- [x] Keyboard shortcuts and 1024 responsive drawers

**Deliverables**:
```
Complete MVP UI
English and Chinese basic copy
```

Evidence: Phase 2–6 frontend tests cover the analyzed-video wizard and run-control matrix; Rust tests cover artifact parsing, lifecycle, settings, and redaction. Edge/Playwright captures at 1440×1024 and 1024×768 are recorded in the ignored `.artifacts/ui-redesign/screenshots/` directory, with the final comparison documented in `design-qa.md`.

### Week 10 — Packaging, Updates & Licensing

**Goal**: Distributable Windows build.

**Tasks**:
- [ ] Windows installer
- [ ] Windows portable build
- [x] Engine pack structure
- [ ] Engine integrity validation
- [x] SHA-256 checksums
- [ ] Third-party license page
- [x] Engine version info
- [ ] Crash log collection notice
- [ ] Auto-update design (manual check initially)

**Deliverables**:
```
Splat-Setup-x.y.z.exe
Splat-Portable-x.y.z.zip
THIRD_PARTY_NOTICES
```

### Week 11 — Testing & Performance

**Goal**: Enter Beta.

**Test Matrix**:

| Type     | Content                                               |
| -------- | ----------------------------------------------------- |
| System   | Windows 10, Windows 11                                |
| Paths    | English, CJK, spaces, long paths                     |
| Video    | MP4, MOV, landscape, portrait                        |
| Images   | JPG, PNG, mixed resolutions                          |
| GPU      | At least 2 device classes                            |
| Failure  | Blurry, low texture, dynamic objects                 |
| Resources| Low disk, low memory, low VRAM                       |
| Interrupt| App close, cancel, abnormal exit                     |
| Permissions | Read-only directories, restricted directories    |
| Re-runs  | Multiple executions on same project                  |

**Deliverables**:
```
Test report
Known issues
Performance baseline
Beta installer
```

### Week 12 — Public Release

**Goal**: Release `v0.1.0-alpha` or `v0.1.0-beta`.

**Tasks**:
- [ ] Polish README
- [ ] Add screenshots and demo
- [ ] Write installation guide
- [ ] Write capture guide
- [ ] Write troubleshooting guide
- [ ] Create GitHub Release
- [ ] Create Roadmap
- [ ] Enable Discussions
- [ ] Prepare initial issues
- [ ] Document known limitations
- [ ] Establish community feedback process

## Development Phase Ordering

```
Phase 0:  Repository Audit
Phase 1:  Engineering Foundation (Rust workspace, frontend, CI, docs)
Phase 2:  Domain & Project Model
Phase 3:  ProcessRunner
Phase 4:  FFmpeg
Phase 5:  COLMAP
Phase 6:  Brush
Phase 7:  Pipeline Orchestration
Phase 8:  Desktop UI
Phase 9:  Packaging
Phase 10: QA & Release
```

## Claude Code Task Sequence

Strictly sequential. One task at a time.

```text
1.  Repository audit & engineering init
2.  Domain model
3.  Project Manager
4.  ProcessRunner
5.  ProcessRunner Windows cancellation & process tree
6.  FFmpeg capability detection
7.  FFprobe video metadata
8.  FFmpeg frame extraction
9.  COLMAP capability detection
10. COLMAP Feature Extraction
11. COLMAP Matching
12. COLMAP Mapping
13. COLMAP result validation
14. Brush capability detection
15. Brush dataset validation
16. Brush training execution
17. Brush Checkpoint & output
18. Pipeline state machine
19. Pipeline caching & skipping
20. Pipeline crash recovery
21. Home page & new project UI
22. Media analysis UI
23. Training progress UI
24. Log & error UI
25. Results & export UI
26. Windows packaging
27. Third-party licenses
28. Test matrix
29. Beta Release
```

Each task maintains:
```
One clear goal
One set of related files
One explicit test
One reviewable PR
```
