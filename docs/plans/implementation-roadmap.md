# Implementation Roadmap

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
- [ ] Manual FFmpeg frame extraction
- [ ] Manual COLMAP execution
- [ ] Verify COLMAP output
- [ ] Manual Brush execution
- [ ] Verify output model
- [ ] Record all commands, versions, errors, GPU/time/disk metrics

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
- [ ] Initialize Rust workspace
- [ ] Initialize Tauri application
- [ ] Initialize React + TypeScript frontend
- [ ] Create `splat-domain` crate
- [ ] Create `splat-project` crate
- [ ] Define Project schema
- [ ] Define Stage and Status types
- [ ] Define AppError
- [ ] Add JSON Schema definitions
- [ ] Add serialization tests
- [ ] Add project migration interface

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
- [ ] Implement shell-free command execution
- [ ] Implement stdout/stderr streaming
- [ ] Implement log file writing
- [ ] Implement exit code handling
- [ ] Implement cancellation
- [ ] Implement Windows process tree termination
- [ ] Implement UTF-8 and system encoding compatibility
- [ ] Implement event notification
- [ ] Add fake process test utility
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
- [ ] FFmpeg capability detection
- [ ] FFprobe metadata reading
- [ ] Video metadata parsing
- [ ] Frame extraction plan calculation
- [ ] Space estimation
- [ ] Real-time progress parsing
- [ ] Output frame validation
- [ ] Rotation metadata handling
- [ ] Failure error mapping
- [ ] UI video import flow

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
- [ ] COLMAP version detection
- [ ] Database creation
- [ ] Feature Extraction
- [ ] Sequential Matching
- [ ] Exhaustive Matching
- [ ] Log parsing
- [ ] Progress estimation
- [ ] Input image validation
- [ ] Database output verification
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
- [ ] Mapper execution
- [ ] Model directory detection
- [ ] Best model selection
- [ ] Registered image count parsing
- [ ] Camera count parsing
- [ ] Sparse point count parsing
- [ ] Success threshold definition
- [ ] Diagnostic report output
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
- [ ] Pin Brush version
- [ ] Implement Brush detection
- [ ] Check data compatibility
- [ ] Generate training configuration
- [ ] Start training
- [ ] Parse training progress
- [ ] Detect output
- [ ] Detect checkpoints
- [ ] Training cancellation
- [ ] Training resume verification
- [ ] Output model validation

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
- [ ] Implement Pipeline Orchestrator
- [ ] Implement dependency resolution
- [ ] Implement stage skipping
- [ ] Implement stage retry
- [ ] Implement crash recovery
- [ ] Implement incomplete project detection on startup
- [ ] Implement output integrity validation
- [ ] Implement cancel-with-data-preservation
- [ ] Implement project lock
- [ ] Prevent concurrent runs on the same project

**Deliverables**:
```
Complete pipeline state machine
Recovery flow
Project lock mechanism
```

### Week 9 — Desktop UI Polish

**Goal**: Complete usable desktop product flow.

**Tasks**:
- [ ] Home page
- [ ] New project wizard
- [ ] Recent projects
- [ ] Media analysis page
- [ ] Preset selection
- [ ] Training page
- [ ] Log page
- [ ] Results page
- [ ] Settings page
- [ ] User-facing error prompts
- [ ] Loading / Empty / Error states
- [ ] Keyboard and window adaptations

**Deliverables**:
```
Complete MVP UI
English and Chinese basic copy
```

### Week 10 — Packaging, Updates & Licensing

**Goal**: Distributable Windows build.

**Tasks**:
- [ ] Windows installer
- [ ] Windows portable build
- [ ] Engine pack structure
- [ ] Engine integrity validation
- [ ] SHA-256 checksums
- [ ] Third-party license page
- [ ] Engine version info
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
