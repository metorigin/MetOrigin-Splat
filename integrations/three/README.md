# Three OrbitControls event-root patch

This directory binds the local derivative of Three **0.185.1** to
[`patch-manifest.json`](patch-manifest.json) and
[`../../patches/three@0.185.1.patch`](../../patches/three@0.185.1.patch).
Only `examples/jsm/controls/OrbitControls.js` changes. Its upstream MIT license
continues to apply; the patched file is a local derivative, not original npm
bytes. Package registration and installed-source verification are separate
gates owned by the build integration.

The original controls registers its Control-key interceptor on the canvas's
current root, then recomputes that root during disconnect. If React or another
caller first detaches the containing DOM, disconnect removes the callback from
the detached tree while the original Document still retains the bound controls,
camera and canvas. It also leaves a pending Control-keyup interceptor behind.

The patch stores the registration root for each connection. Disconnect removes
both root callbacks, clears the saved root and resets held-Control state.
Keyup continues to use the saved registration root after DOM movement. The root
field is initialized before the constructor calls `connect`, because inherited
`Controls.connect` first disconnects an existing element. Never-connected and
repeated disposal remain safe, and reconnect cleans the previous root before
registering the next one. Document and ShadowRoot semantics are preserved.

No renderer, camera, model, worker, WebGL cleanup, React hook timing or public
API is changed. The patch does not null object/canvas references to hide an
outstanding listener.

Run the real installed-module regressions from the repository root:

```sh
node --test integrations/three/orbit-controls.test.mjs
```

The harness uses the project's existing jsdom and actual installed OrbitControls
and Three camera. It reads jsdom's actual listener table and dispatches keyboard
events; it does not stub controls or replace EventTarget registration methods.
The 18 cases cover attached/detached disposal, held Control, keyup after DOM
movement, same-root/cross-document/ShadowRoot reconnect, never-connected controls
and idempotence. A scratch-source override is supported only for pre-install
review through `METORIGIN_THREE_ORBIT_SOURCE`; that mode resolves the source's
single `three` import to the installed module and reports the original source
hash and override mode explicitly.

The first baseline on unpatched `0.185.1` passed 2 and failed 16; the scratch
derivative passed all 18. Baseline evidence remains in
`target/macos-m4/native-retention-census-20261028/orbit-patch/`; subsequent evidence
belongs to `target/macos-m4/orbit-controls-root-fix-20261028/`. Installation and
its own green run must bind the actual resolved package before packaging.

These are deterministic DOM/listener regressions, not GC, native WKWebView,
rendering quality or memory-size measurements. Test variables deliberately hold
the objects during assertions. Native retention findings and M3/M4 acceptance
remain open until separately recorded evidence supports their closure.
