# Spark resource lifecycle patch and regression tests

The pinned `@sparkjsdev/spark@2.1.0` package has a tracked pnpm patch in
`patches/@sparkjsdev__spark@2.1.0.patch`. It marks disposal before releasing
resources, cancels scheduled renderer updates/sorts, and checks lifetime after
each await in the non-LOD sorting path. Stale work exits safely; active-renderer
errors still propagate and `sorting` is cleared before `onDirty` callbacks.
No rendering parameters, project formats or engine interfaces change.

The resource ownership extension gives each underlying Three renderer its own
compute quad geometry, compute materials and fallback texture wrappers. Spark
and the standalone SplatAccumulator, Readback and PackedSplats helpers hold
explicit consumer leases; the last release disposes the owner's resources.
Materials remain separate per consumer, and nested draws preserve the outer
draw's uniform values. Retired programs are released when mappings change.
Original shared templates, legacy `DynoProgram.prepareMaterial()` results and
caller-owned model textures are not adopted or disposed.

Dispose Spark and its standalone helpers before disposing their underlying
WebGLRenderer. A standalone helper must be disposed before switching renderers;
it can then bind again as a new generation. Work captured before that disposal
is invalidated. Capacity changes only release render targets, without retiring
the consumer's resource lease. Helper `prepareProgramMaterial` methods accept an
optional renderer for internal managed draws; the resulting material's uniforms
are refreshed by that draw scope, so it is not a separately renderable public
material handle. Manual preparation/rendering continues to use the legacy
no-renderer path with caller-owned materials. Spark also releases its originally created display geometry and
material, without disposing replacement resources supplied by a caller.

Only the ESM/CJS files selected by the package exports and four related type
declarations are patched. Their stale source-map links are removed; unused minified modules
remain upstream bytes. `patch-manifest.json` binds the original and derived file
hashes, package identity and patch. The verifier checks installed files against
the workspace/lock registration, and macOS packaging binds that evidence before
and after building. Updating Spark requires reviewing and regenerating this
patch and its manifest, then repeating lifecycle and native verification.

This correction does not cancel a submitted GPU Promise or the short pause
Promise timers, repair LOD/pager/cube/environment helper lifetimes, or clear the
global decoder pool. It prevents covered stale continuations from recreating
resources after disposal. The ownership extension covers the active non-LOD
fallbacks, including the `emptyLodIndices` sampler. It does not yet prove the
cause or resolution of native memory growth.

Run from the repository root after installing dependencies:

```sh
pnpm test:spark:lifecycle
```

The tests load the actual installed `@sparkjsdev/spark` 2.1.0 ESM module and print its SHA-256. They construct real Spark objects and call the installed lifecycle methods, including private methods exposed in the compiled JavaScript. Neither harness copies, rewrites or mocks those methods. A version change requires reassessing the coverage.

The sorting suite covers normal sorting and reuse, synchronous `onDirty` reentry, every asynchronous boundary in `driveSort` (`readPause`, GPU readback, `sortPause`, Worker result and `sortDelay`), both scheduled sort/update timers, and ordinary GPU/Worker failures. Disposal must settle stale work without rebuilding resources or surfacing stale errors; errors from a live renderer must retain their original identity. Rejection handlers are attached immediately to all test-started sorting tasks.

In that sorting suite, only environment boundaries are replaced:

- GPU readback is a controlled Promise; no GPU commands or WebGL context are created.
- Browser Worker is an in-process protocol stub. Spark's real Worker wrapper sends the messages. Replies use an identity ordering, and `structuredClone` applies transfer lists in both directions. No sorting WASM or OS Worker runs.
- Calls to `setTimeout` originating from the actual Spark module use a manually advanced clock. This exposes precise ordering without wall-clock sleeps; Node's test timeouts remain real.
- Navigator fields are synthetic. Only embedded `data:` fetches are permitted; importing Spark can initialize its bundled WASM.
- Three's texture and render-target JavaScript objects are real, but their existence does not prove GPU allocation or retained memory.

Fixtures use a single synthetic splat and run sequentially. They are cleaned up even when an assertion fails. Each test has a two-second Node deadline. Run logs should additionally use a bounded outer process timeout.

The resource ownership suite separately constructs actual Three WebGLRenderer
instances with a stub WebGL API. It exercises real geometry, material/program
and texture disposal listeners, independent renderers and multiple consumers
of one renderer, standalone helper lifetimes, empty and loaded non-LOD bindings,
borrowed textures, legacy materials, resize/rebind, program replacement and
nested rendering. Since the stub shader does not reflect active uniforms, the
harness explicitly calls the real `initTexture` for captured sampler bindings.
This tests JavaScript ownership and actual Three cleanup, not shader compilation
or GPU pixels. Readback completion remains a controlled boundary.

These tests do not execute React's complete cleanup, WKWebView, the native app,
native resource sampling or the six-cycle acceptance flow. Passing them cannot
establish the cause or resolution of native WebContent growth or confer M3/M4
or release acceptance. The component's separate frontend tests check failure
cleanup and mesh/Spark/renderer disposal order.
