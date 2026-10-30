# macOS application dependency evidence

Current status (2026-10-28): the complete `ee0f0bea` application and
`build.Lotfbt` DMG bind the fixed-source WebP replacement and expanded Spark
resource-ownership patch to a 726-listed-file license collection with no
findings. The former collections and historical findings are preserved.
The subsequent [bounded native closeout](../../target/macos-m4/native-spark-resource-ownership-cycles-20261028/native/closeout.json)
verified Spark/Home display, normal quit action and project integrity, while
native memory acceptance remains false. Earlier `6a5c7be6` memory-retention
findings remain open, and public-release readiness is false.
See the [current package binding](#2026-10-28-spark-resource-ownership-package-binding).
Earlier sections retain the findings and scope of their historical collections;
the old binary's provenance remains unknown.

## 2026-10-28 Spark resource ownership package binding

The expanded Spark 2.1.0 patch has SHA-256
`eb4e6b310d3a694ae155b92ed461b1efbbd7797328e200b319af77f478525933`.
Its [installed identity](../../target/macos-m4/spark-resource-ownership-fix-20261028/installed-patch.json)
binds the selected ESM/CJS modules and four declarations; these are local
derivatives, not original npm bytes. The [new package receipt](../../target/macos-m4/spark-resource-ownership-fix-20261028/acceptance-summary.json)
binds application SHA-256
`ee0f0beaae735811eaee41c068204e434d1208a4422afc1e7e2704fd9a65d1cd`
and DMG SHA-256
`0ee24a97cfd2ffc0858b03c28a7d839ff803a191cf0bcd96cb789f03236aa617`
to license manifest SHA-256
`1664a91001e6e4a7958f6c79927fb912c9a4e775c7f9747ca0997ad634d25fea`.
The collection lists 726 files and has zero issues. Installed patch, workspace
registration and locked dependency resolution were checked; all 589 bound
source inputs were unchanged across checks and complete app/DMG construction.

The [gate record](../../target/macos-m4/spark-resource-ownership-fix-20261028/gates.json)
distinguishes fresh 58 Spark / 292 frontend checks and typecheck/lint from
historical Rust 738 / 15 ignored, fmt/Clippy and schema 36 reuse. Package
signatures, read-only DMG mounting and bundle equality passed, but the app is
ad-hoc signed. The immutable package receipts retain their native-pending
creation state; the later [resource closeout](macos-m3-resources.md#2026-10-28-ee0f-native-spark-only-closeout-with-retention-unresolved)
still leaves memory stability unaccepted. License findings of zero do not
confer Developer ID, notarization, M3/M4 or public-release acceptance. The
previous license manifest and `6a5c7be6` findings remain history.

## 2026-10-28 Spark lifecycle package binding

The fixed npm Spark 2.1.0 base is locally derived through a tracked pnpm patch;
the selected ESM/CJS modules and declaration are not described as original npm
bytes. Workspace/lock registration, the actual resolved package exports and
the three installed files are checked before and after packaging. The patch,
manifest and portable installed-input identity are included in the license
collection, and the Spark inventory component explicitly records the derivation.
No dependency version changed; the prior lockfile is restored byte-for-byte by
removing only the new patch binding.

The first collection's new Spark report included a development-machine absolute
path. Packaging was stopped during preflight before a new candidate was created.
An explicit field allowlist and rejection tests now keep that path in local CLI
diagnostics only. The corrected collection's manifest SHA-256 is
`b28138050f1584bee253714b32fd7cc414370ff31fdaf15ab25dd45cfd860d51`, with 726 files,
611 license records and `issues=[]`. The bundled Spark report was separately
checked for the portable field set. The [package receipt](../../target/macos-m4/spark-lifecycle-fix-20261028/acceptance-summary.json)
binds this collection to `6a5c7be6` and the verified DMG. These checks establish
the recorded provenance scope, not public-release or native-memory acceptance.

`scripts/macos/collect-app-licenses.mjs` collects an offline application inventory into a new output directory. It refuses to overwrite an earlier run. The default is `target/macos-m4/app-license-evidence/licenses/`; the engine pack retains its separate audit.

The historical source-audit collection described below contained 296 Cargo components from the desktop's `aarch64-apple-darwin` normal/build dependency tree and 34 installed npm components. Production desktop dependencies are included before tree shaking. SuperSplat 3.0.1's pinned source map additionally identifies its runtime packages, including packages declared as upstream build dependencies. Its original MIT license, generated third-party notices, source identity and static-payload hashes are retained. Inter and JetBrains Mono include their original Fontsource OFL texts.

There were 564 notice records and 612 files covered by `manifest.json` (which excludes itself). In addition to the 330 Cargo/npm components, two explicit vendored components identify SQLite and WebP WASM. Every evidence file has a byte count and SHA-256. The CycloneDX 1.6 inventory declares incomplete composition; all dependency references and notice references were checked. Legacy Cargo slash license declarations are normalized to SPDX `OR` expressions while the original declaration remains in the audit. Captured Cargo and npm lockfiles/manifests matched that run’s source inputs. The app verifier binds this collection to the installed bundle and rejects tampering, missing files and links.

That historical source-audit manifest SHA-256 is `7de8b1ee0ffceda57eea3408c97432237c5f0164cd4b160a5482a6b2ab19f2df`. The former 570-file collection is preserved at `target/macos-m4/app-license-evidence/licenses-before-source-audit/`; no prior evidence was overwritten.

Nine objc2-family notices omitted from published package contents were recovered from already frozen upstream evidence. Recovery verifies the local `.crate` against its Cargo.lock checksum, the archived manifest against the resolved source manifest, the published `.cargo_vcs_info.json` revision, the exact repository/revision URL and the old engine manifest's notice hash. No copyright statement is synthesized. Ordinary source files such as `copying.rs` are excluded from filename-based notice collection.

The source audit explicitly reused the immutable `.5` engine archive at `target/distribution/macos-arm64-archive-macos5-1a257513a680-20261027T045148Z/engines`. `APP_LICENSE_ENGINE_PACK` selects that evidence root; otherwise the collector uses the active pack. Its manifest remains `1a257513a6806775a620a28c837d7079cafc44a1105793ba58624fedc93579d6`. A source file incorrectly called a notice by the older engine audit is never reused.

`packaging/macos-arm64/licenses/app-upstream-notices.json` now pins original upstream texts for alloc-stdlib 0.2.4, five unic 0.9.0 crates and tauri-plugin 2.6.3. Original bytes are checked using SHA-256 and Git blob SHA-1, and the exact crate checksum/repository/VCS commit must match. `selectors 0.36.1` publishes an MPL Exhibit A header but no full LICENSE file. The collection preserves its original `lib.rs`, full unmodified checksum-bound crate, and the standard MPL 2.0 text from a fixed revision of Mozilla's official website repository. That standard license is clearly distinguished from a project-specific original notice.

That source-audit collection's `release-readiness.json` was `release_ready: false`.
Its findings at the time were:

- **sigchld 0.2.4:** the published crate and exact upstream revision `07b95e2fe38b18b376b0f635f2766bf2e641b80b` declare MIT but contain no original complete MIT grant. An author copyright or grant has not been invented.
- **WebP WASM:** the bundled SHA-256 `e2c337e1afacf5c9e35f21916b5615fc6c5623074c6e110c07791bd0af071501` equals splat-transform 3.4.2 at `0cb47cd81023cca117c20ce59a55ba584ee89177`. Its original C wrapper, MIT notice and `lib/BUILD.md` are retained. The recipe does not pin libwebp, libsharpyuv or Emscripten versions, and those exact compiled components' notices remain unresolved. The wrapper's MIT license is not represented as covering libwebp.
- **Unicode data:** unic-ucd-ident's tables and exact UCD submodule identify Unicode 10.0.0. The original submodule ReadMe retains the 2017 Unicode copyright and terms URL. The full historical data permission text is absent from the submodule and remains under review.
- **Static images:** two SuperSplat logo PNGs and two screenshot JPGs have pinned source/payload hashes; independent image content and trademark permission evidence remains incomplete. Nine locale JSON files are also inventoried.
- **Completeness:** the inventory is not a symbol-level binary SBOM. Compiler/SDK and other source-level vendored material are not exhaustively mapped; engine source-distribution work remains separate.

Bundled SQLite is now explicitly identified as **3.50.2**, source ID `2025-06-28 14:00:48 2af157d77fb1304a74176eaee7fbc7c7e932d946bf25325e9c26c91db19e3079`. Its actual source disclaimer is copied verbatim, and the complete checksum-bound libsqlite3-sys 0.35.0 crate is supplied. Cargo's `bundled` selection is recorded without claiming that SQLCipher or the wasm32 WASI helper is part of the macOS runtime.

SuperSplat's PCUI React peer declarations are recorded separately as uninstalled in that package tree, rather than claimed as bundled. Desktop React is inventoried independently. The 612-file collection passed the app verifier in internal-alpha mode, plus independent file-hash/size and SBOM/notice-reference checks. That collection’s public release readiness failed closed on the findings above.

This is a source dependency and notice inventory, not distribution clearance. The final application binary, signing and notarization are verified separately. An internal-alpha flag may acknowledge these recorded gaps; it never bypasses the evidence file hashes.


## 2026-10-27: nested Unicode notice and current editor evidence

A bounded audit found a concrete omission in the top-level notice scan:
`regex-syntax 0.8.11/src/unicode_tables/LICENSE-UNICODE`. The collector now reads
this exact member from the Cargo.lock checksum-verified crate, retaining the
original 2,847 bytes, archive checksum, member path and published VCS revision.
The notice SHA-256 is `74db5baf44a41b1000312c673544b3374e4198af5605c7f9080a402cec42cfa3`.
It is the original 1991–2018 Unicode text distributed by regex-syntax; it is not
labelled as a recovered 2017 Unicode 10.0 web page.

A fresh collection at
`target/macos-m4/app-license-evidence/licenses-spark-framing-20261027/`
contains **565 notices and 613 manifest-listed files**. Its manifest SHA-256 is
`b03b58dd281cea7718a03405265790337170c5073661a444e426cd4160120526`.
The normal app verifier passed in internal-alpha mode. A separate Python tar
reader confirmed byte identity with the locked crate member. The collection
also refreshes SuperSplat build identity to
`dd5be040011f8a842dffde507b95f6309277f8655cd43ea149b14a1331639955`
and source-map SHA-256 to
`bbfb31ad731436b687ba122276191622d9e15a5a3c809eb3d655e3559392fd28`;
the eight runtime package roots are unchanged. See the
[collection execution](../../target/macos-m4/license-refresh-spark-framing-20261027/collection-result.json),
[verifier result](../../target/macos-m4/license-refresh-spark-framing-20261027/verified-collection.json)
and [content checks](../../target/macos-m4/license-refresh-spark-framing-20261027/independent-content-check.json).

The existing 9e25 application still contains its frozen 612-file collection,
manifest `d6c37a1aab1c09b40eadacf5351432d59f0b3963f1a38d5102bdd232c2d84b75`.
This refresh has not been retroactively assigned to that bundle. No original
copyright text was synthesized and no previous evidence was overwritten.
The five top-level findings remain open in the fresh report; this change closes
the specific nested-notice omission only.

### Scoped findings and the next package collection

The [independent focused review](../../target/macos-m4/license-refresh-spark-framing-20261027/independent-focused-review.json)
checked the nested notice, unchanged historical evidence, and the updated
provenance of nine reused notices. Their original text is unchanged; the new
collection explicitly binds their source to the preserved `.5` engine archive,
rather than the current pack. Its original manifest, audit and notice hashes
were independently rechecked.

Two previously unconditional findings have been reclassified. The thirteen
images/translations match the fixed upstream Git tree and its original MIT
notice; no asset-specific exclusion was found. The collector now enforces these
byte identities and emits `supersplat/static-origin-evidence.json`. It excludes
WebP from this assertion, and does not claim trademark rights or endorsement.
The source inventory's lack of symbol-level binary mapping is retained as a
coverage limitation, not an invented absent permission for unshipped SDK or
compiler tools. Specific unresolved bundled components remain named issues.

The second, separately preserved collection at
`target/macos-m4/app-license-evidence/licenses-spark-framing-v2-20261027/`
contains **565 notices and 614 manifest-listed files**, manifest SHA-256
`2f586df635ece297b8519b53b923381e811ad964780b5f24b6dbd47c35b91f60`.
[Independent v2 review](../../target/macos-m4/license-refresh-spark-framing-20261027/independent-candidate-license-v2-review.json)
and the normal verifier passed. The three remaining issues at that closeout were sigchld's original
MIT notice, WebP's compiled source/provenance, and the Unicode 10.0 data terms;
`release_ready` was false. This was an evidence classification correction,
not a public-release approval.

The v2 bytes were promoted to the default collection for the next candidate.
The former default is preserved unchanged at
`licenses-before-spark-framing-20261027/`; the
[promotion record](../../target/macos-m4/license-refresh-spark-framing-20261027/promotion-result.json)
maps both inventories. The 9e25 application and its embedded evidence remain
unchanged. New application binding must be established by its own build report.

## 2026-10-28: unused shell dependency and Unicode 10 data notice

The application did not call the Tauri shell plugin: source references were
limited to its Rust/npm declarations, registration and six capabilities. Engine
execution remains in `splat-process`, and file opening remains in the opener
plugin. Removing that unused plugin removed `tauri-plugin-shell`, `shared_child`,
`sigchld`, `os_pipe` and `signal-hook` from Cargo.lock, and the npm shell package.
The other locked package entries are unchanged. Fresh Rust tests passed 729
cases with 15 environment-specific cases ignored; fmt and Clippy passed.
This removes the unused component from the application closure; it does not
invent or recover a grant for historical sigchld-containing packages.

The official `unicode-org/cldr` release-32 commit
`5dfac9269ed58eeaeddd6ca887bdc7eb43a481fd` retains the full 1991–2017 Unicode
data license. Its original 2,849 bytes, including BOM and no final newline, have
SHA-256 `6a6976a5da6ac21a6a001c685c057f4a6e619be11f5465371088ecd80c7fbe06`.
The text explicitly covers Unicode `/Public/` data, excluding PDF code charts.
The collector verifies its SHA-256, Git blob, fixed source URL and scope, and
binds it to the checksum/VCS-verified `unic-ucd-ident` crate's Unicode 10.0.0
version member and pinned UCD ReadMe. It emits a distinct Unicode UCD component,
dependency edge, original notice and applicability evidence. This is the
historical license preserved by official CLDR, not a restored 2017 website
snapshot. Nine source-guard cases passed, including missing, altered and
mismatched evidence.

The historical `licenses-editor-capture-20261028/` collection contained **610 files,
558 notices, 291 Cargo components and 33 npm components**. Manifest SHA-256 is
`9991557ac802d2f8b8b9b7393a0126d5b765afba228cf0b160a68cd8d36e480f`.
Independent content/SBOM checks and the standard verifier passed; missing and
tampered Unicode evidence and public-release mode were rejected as expected.
Only the exact WebP WASM compiled-source finding remained open in that collection,
so its report had `release_ready=false`.

The [promotion receipt](../../target/macos-m4/license-followup-20261028/promotion-editor-capture-result.json)
bound that immutable collection to the default directory. The previous
614-file default was preserved byte-identically in
`licenses-before-editor-capture-20261028/`. That collection became the input to
the 6925 build without replacing the license identity of earlier bundles.

## 2026-10-28 fixed-source WebP replacement

The replacement is based on libwebp 1.6.0 at
`4fa21912338357f89e4fd51cf2368325b59e9bd9`, its sharpyuv 0.4.2 source,
emsdk 4.0.21 at `b2436aafa7351ee1b581f15841f1b45ed716a279`, and Emscripten
`d6f42310010ddec0753a69bab01a4b33aae255b7`. The original splat-transform
3.4.2 C wrapper is unchanged. A recorded TypeScript patch releases temporary
allocations and library-owned output when encoding/decoding or copying throws.
The [original unredacted v2 build-evidence snapshot](../../target/macos-m4/webp-rebuild-20261028/v2/build-evidence.json)
has SHA-256 `d5b9bb0d38bb3f611656455a2853651469e5ed1f5c02cae965396630c873ecaa`.
This checksum identifies that historical local snapshot, not the repository's
later path-normalized publication copy. The [profile README](../../integrations/supersplat/webp-overlay/README.md)
and its `build-evidence.json` record the publication scope and original file
identities. Path normalization does not rerun the build or tests, or replace
the historical acceptance recorded here.

The repository's `integrations/supersplat/webp-overlay/` contains ten paired gzip
payloads (7,742,580 bytes), their manifest and the selected evidence. The historical,
pre-normalization manifest SHA-256 was
`adf23d22d9128378d99466a2ad4361a2e2fb20aaae17d486f181064007dea5a5`.
The unchanged C/WASM/glue retain their original binary/ABI test results. The v2
cleanup checks cover 22 primary cases, 44 recovery calls and five successful
output comparisons; 18 upstream format tests and actual ESM/worker checks pass.
Fully transparent pixels retain the original libwebp `exact=0` contract; hidden
RGB is not claimed to be byte-preserved. Ordinary Node CJS loading has the same
PlayCanvas constructor failure in the original and derived packages; the adapted
external-module check passes. Browser/WKWebView execution remains a native gate.

The link map identifies 94 archive members, including 32 runtime members mapped
to their sources. The retained subset has 106 evidence files and 48 runtime
notice/source records. Complete libwebp COPYING/PATENTS/AUTHORS, Emscripten and
musl notices, compiler-rt terms, dlmalloc and file-specific math/qsort notices
are preserved. Both validators bind the complete reviewed source/notice sets;
deleting a source, remapping it to another licensed file, or removing the finding
without a complete replacement record fails even when outer hashes are updated.
Build-only SDK archives are identified by official fixed URLs and hashes, without
bundling the approximately 297 MB SDK into the application.

The [audited collection](../../target/macos-m4/app-license-evidence/licenses-webp-source-audited-20261028/manifest.json)
contains **722 files, 611 notices, 291 Cargo components and 36 npm components**;
its manifest SHA-256 is
`60575302453eeb2d1124c6c3f537b68976764db174ca44439b08c294b11dceb5`.
The three additional npm inventory entries are React 19.2.0, React DOM 19.2.0
and scheduler 0.27.0 present after reinstalling the fixed SuperSplat lockfile.
This remains a source inventory before tree shaking, not a claim that all three
are runtime additions to the application. The [independent verifier](../../target/macos-m4/webp-integration-20261028/verified-license-evidence.json)
passes without the internal-alpha exception: `release_ready=true`, `issues=[]`.
The earlier 722-file collection is retained separately; the audited collection
refreshes the preparation signature after the semantic guards were strengthened.

The [25 packaging checks](../../target/macos-m4/webp-integration-20261028/packaging-tests-audited.json)
and [frontend build](../../target/macos-m4/webp-integration-20261028/frontend-build-audited.json)
pass. The [frontend input receipt](../../target/macos-m4/webp-integration-20261028/frontend-inputs.json)
binds 24 assets plus `build.json` across public, Vite dist and this collection;
its SHA-256 is `fd7b7f77e44028f865efa59928f000b1af6f92fc0a811eb030ff1f162c047e0e`.
The Python app verifier accepts this exact receipt and requires it for future
derived-codec app/DMG verification. This binds build inputs; it is not frontend
extraction from Mach-O or symbol-level SBOM completeness.

No complete app/DMG was built in that source-integration step. At its closeout,
the 6925 bundle and then-default 610-file collection still carried the old
finding; promotion and fresh application/native verification were pending.
The subsequent complete packaging result is recorded below. Historical evidence
is not relabelled.

## 2026-10-28 complete WebP application and DMG binding

The audited 722-file collection was copied and independently verified before
selection as the default. The [promotion receipt](../../target/macos-m4/release-package-webp-20261028/license-promotion.json)
binds manifest `60575302453eeb2d1124c6c3f537b68976764db174ca44439b08c294b11dceb5`
to the new default; the former 610-file collection remains at
`licenses-before-webp-20261028/` with its original `9991557a` manifest. An initial
preparation stopped on inventory ordering before changing either collection;
that failure receipt remains, and the successful preparation compared records
by path before copying and promotion.

One complete standard internal Alpha build then ran in **249.75 seconds** and
exited 0. Its [build receipt](../../target/macos-m4/release-package-webp-20261028/acceptance-summary.json)
and [final verification](../../target/macos-m4/app-verification/build.zid9up/final.json)
bind these artifacts:

| Artifact | SHA-256 |
| --- | --- |
| Application executable | `ebefccae78577fb9fa9ed83418ff62b8aa426d6797fc3c06a5ea2ab4cff54e80` |
| Complete bundle inventory | `870387725969b7112c962c6deb911c78a497d549acdc8f619986c887a2efde87` |
| DMG | `af4fcc9a8485624c601ccaabf738228242177d07713c5a4903149e4f8ea18e12` |
| Final packaging verification | `3f5dbe386aae5c3b4ebcbb406b350e256e17f8b29e6a9dbb3552267d4124bb93` |

The bundled license check reports **722 files, `release_ready=true`, `issues=[]`**,
with 106 build-evidence files, 48 runtime notice/source records and 94 linked
members. The final report includes the exact frontend receipt SHA-256
`fd7b7f77e44028f865efa59928f000b1af6f92fc0a811eb030ff1f162c047e0e` and
`dist_verified=true`. Public assets, Vite dist, collected `build.json` and the
overlay identity agree. The DMG was mounted read-only; its entire embedded app
matched the verified signed bundle. This is a build-input and final-bundle
binding, not extraction of frontend bytes from Mach-O.

All **576 frozen source inputs**, including the complete **118-file controlled
overlay**, stayed unchanged. The union explicitly includes 14 ignored overlay
files omitted by the earlier Git-selected fingerprint. The 25 public editor
assets and 722 license files also stayed unchanged. The
[input review](../../target/macos-m4/release-package-webp-20261028/input-delta-review.json)
supports reuse of **235 frontend tests** and **729 Rust tests / 15 ignored**
against unchanged inputs. The **36 schema fixtures** were reused within their
unchanged 50 substantive inputs; two recorded metadata files only added the
packaging-test command. The old claim that all 52 schema inputs were byte-identical
was not transferred. Fresh engine/application preflight and production frontend
compilation ran in the complete build.

The [independent package review](../../target/macos-m4/release-package-webp-20261028/package-review.json)
checks the small receipts, source snapshots and cross-report hashes without
repeating the builder's complete app, DMG or license scan. **Native WebP acceptance
is pending at this packaging closeout.** The original prebuilt codec's provenance
remains unresolved as historical evidence. Zero findings in this source/notice
collection do not establish public redistribution clearance, symbol-level SBOM
completeness, Developer ID, notarization, clean-host or broader M3/M4 acceptance;
`application_public_release_ready=false` remains explicit.

## 2026-10-28 stable image capture package binding

The current collection is `target/macos-m4/app-license-evidence/licenses/`, also
preserved as `licenses-image-render-quality-20261028/`. Its manifest SHA-256 is
`62254c372e700b3b0220287e9860a93ad48809ad31e9537562291b849f14eedc`;
722 payload files include 611 notices, covering 291 Cargo and 36 npm records,
with `issues=[]`. The preceding 6095 collection remains under
`licenses-before-image-render-quality-20261028/`.

The [package receipt](../../target/macos-m4/image-render-quality-20261028/acceptance-summary.json)
binds this collection to application SHA-256
`0f85289e89e606c4732675347c138bf1b922e1bc8c1a49453c487310e6685180`
and DMG SHA-256
`0a403c7603db77238dd1e8b0d261f67bbcf07eca6705f183917ed8264661c2a5`.
The complete build verified signatures, read-only DMG contents and bundle
equality; its packaging-time native-pending status is retained as history.
The later [native closeout](../../target/macos-m4/image-render-quality-20261028/native/closeout.json)
records three actual 320×240 image exports and scoped lifecycle checks. License
findings remain zero; complete M3/M4 acceptance, Developer ID, notarization and
public-release readiness remain open.
