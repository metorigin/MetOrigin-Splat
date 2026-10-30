# macOS engine license evidence

`scripts/macos/pack_licenses.py` generates license and provenance trees from the
**actual original dylib closure and the selected COLMAP build directory**. It
does not download source, approve a release, or treat a binary Conda lock as
corresponding source. Use a fresh staging directory for each build.

```sh
python3 scripts/macos/pack_licenses.py \
  --closure /absolute/path/to/closure.json \
  --colmap-build /absolute/path/to/colmap-build \
  --output /absolute/path/to/fresh-pack-staging \
  --include-ffmpeg
```

The closure JSON can be a list of original absolute paths or an object containing
a `files` mapping keyed by those paths. Python callers can use
`collect_licenses(repo_root, closure_paths, output_dir, colmap_build=...)` and
`collect_ffmpeg_licenses(repo_root, output_dir)`. Output paths are
`colmap/licenses/`, `colmap/provenance/audit.json`, and the analogous independent
`ffmpeg/` tree. A caller must retain the audit's issues in its release gate.

The collector:

- Identifies canonical file owners from `conda-meta` without double-counting
  `libblas`, `liblapack`, `libcblas`, or OpenMP alias packages.
- Copies exact cached upstream licenses, complete recipes (including parent
  recipes and patches), package metadata, and SHA-256 records for copied evidence.
- Records upstream source URLs and hashes from rendered recipe source blocks,
  with original line numbers and unmodified block text. These hashes describe
  upstream source archives; they are separate from Conda binary package hashes.
- Selects LSD, VLFeat, PoissonRecon, PoseLib, and FAISS from the final executable
  link statement. CGAL is included only when the selected build enables it.
  Eigen and Boost headers are also included because they compile into COLMAP.
- Obtains the missing FreeType split-package notices from the same upstream
  version and matching feedstock commit. It retains GCC runtime exception texts,
  a locally available standard GPLv3 text, and SQLite's actual source header.
- Keeps package-declared licenses verbatim. In particular, the Conda FFmpeg
  package says `GPL-2.0-or-later`, while its embedded configure string enables
  both GPL and version3; the generated record additionally identifies its
  effective `GPL-3.0-or-later` license.

## Findings from the original M0 build

The original M0 closure has 125 Conda dylibs owned by 90 canonical binary
packages. Every canonical file has one owner, and every selected component has
local license evidence, source URL/hash evidence, and all referenced recipe
patches. `m0-source-index.json` is a compact snapshot of that original build's
source locators, not an inventory for a later Alpha rebuild.

M0 statically links LSD under **AGPL-3.0-or-later**. Its CGAL 6.2.1 headers include
GPL-3.0-or-later modules (`Advancing_front_surface_reconstruction` and
`Triangulation_3`); no commercial-license evidence was found. COLMAP's own
`COPYING.txt` explicitly says its BSD license does not cover dependencies.
Disabling LSD, CGAL, and MVS in a separate build must be confirmed from that
build's cache and final link; the collector does not carry those components
forward merely because they existed in M0.

OpenImageIO brings Conda FFmpeg 9.0.2, x264, x265, libheif, and their transitive
dependencies into the actual closure. CHOLMOD and SPQR also carry GPL code.
Disabling only LSD/CGAL does not make the remaining COLMAP binary BSD-only.
The independent FFmpeg 8.1.2 engine is built with GPL/version3 disabled and is
LGPL-2.1-or-later; its records are kept separate from Conda FFmpeg 9.0.2.

## Outstanding source and license work

Before external binary distribution, provide the exact corresponding source
and applicable build/install scripts for the covered components. Source URLs,
archive hashes, recipes, and notices are useful evidence but are not a delivered
source bundle. The practical route is to acquire each exact archive, verify its
recipe SHA-256, retain the matching patches and build configuration, and make
the resulting source available alongside the binary distribution under the
applicable license. Preserve the exact COLMAP/FFmpeg commits and fetched
PoseLib/FAISS archives, plus any local modifications and packaging scripts.

For LGPL libraries, retain notices and the license text, fulfill the library's
source obligations, and preserve the user's ability to replace/relink the
library and debug modifications. Ad hoc signing and relocation do not by
themselves prove these requirements. GPL/AGPL combined-work obligations need to
be reflected in the engine distribution; describing COLMAP as merely BSD is
incorrect. No conclusion about the separate host application's license is
made here.

The `libgcc` package contains `libquadmath.0.dylib` but declares only
`GPL-3.0-only WITH GCC-exception-3.1` at package level. Verify file-level
libquadmath licensing and notices from the exact GCC 16.2.0 source before
closing that issue. The GCC runtime exception must not be treated as removing
the runtime library's own source-distribution obligations.

Brush/Cargo and LPIPS are outside this collector's scope. System frameworks are
not redistributed. Every generated audit deliberately reports
`release_ready: false` while source acquisition remains incomplete.
