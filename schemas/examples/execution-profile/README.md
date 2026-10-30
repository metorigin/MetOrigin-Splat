# Execution profile v1 fixtures

These synthetic records exercise the standalone `runtime/execution-profile.json`
contract. Their SHA-256 strings identify test inputs, not real engine artifacts.
They do not change the existing `project.json` v1 format, and a legacy project
without an execution profile remains readable.

`macos.valid.json` records explicit CPU SfM, Metal compute evidence, unified-memory
budgets and bounded Brush 1.0 parameters. `macos-patched.valid.json` demonstrates
the same pinned CLI base version with SemVer build metadata. `macos-unknown.valid.json`
is structurally valid diagnostic data but must fail execution readiness checks:
missing device/working-set measurements and capability fields remain unknown.
`windows-legacy.valid.json` preserves the existing NVIDIA driver-check contract,
allows absent source commits and unmeasured legacy engine limits, and records
`legacy_default` without asserting an actual Vulkan/DX12 adapter.

The new profile cannot claim optimizer continuity: the only enabled resume mode is
`ply_warm_start_optimizer_reset`. Live protocol v1 and warm start each require their
own supported capability before execution; disabled live still permits checkpoint
viewing. Stored failed/unknown probes remain readable for diagnostics.

Run the existing CI validator (Ajv CLI, JSON Schema draft 2020-12):

```sh
node schemas/test-execution-profile.mjs
```

If Ajv is installed outside PATH, pass its executable as the first argument:

```sh
node schemas/test-execution-profile.mjs /absolute/path/to/ajv
```

The runner checks every `.valid.json` and `.invalid.json` file and distinguishes
schema/tool failures from expected data rejection. Rust uses the same fixtures:

```sh
cargo test -p splat-domain runtime::tests
```

`ExecutionProfile::from_json` checks the schema version before interpreting v1
fields and preserves structured `AppError` details. Both it and serde deserialization
enforce cross-field invariants. Before spawning an engine, call
`validate_for_execution`; ordinary `validate` intentionally permits unknown probe
results. Validate again before persisting a programmatically constructed or modified
profile; persistence must retain the project's atomic-write semantics.

Standard JSON Schema cannot compare numeric properties against each other. Rust
additionally enforces cache ≤ training budget ≤ known working-set recommendation,
and, for unified memory, training budget ≤ known physical RAM. Dedicated GPU memory
is a separate pool and can exceed system RAM. These budgets describe resource
policy, not hard OS memory limits. No schema default grants a supported capability.

Stable errors: `E-1401` unsupported profile version, `E-1402` invalid profile,
`E-1403` insufficient execution evidence. No operation in this domain module reads
or writes project files, probes hardware, or mutates a stored profile on failure.
