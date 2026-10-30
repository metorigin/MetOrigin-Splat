# LPIPS packed-weight provenance and distribution decision

Audit date: 2026-10-27. Brush base: `1388f74c6fe0236f68ee4915564bf00e9d2e3747`.
This is a recorded engineering distribution decision, not a determination that
any upstream party infringes rights.

## Evidence and gap

The checkout contains `crates/lpips/burn_mapped.bpk`, SHA-256
`ff80f1f56a24c6021d1e82b9957f92ee9a28d1b2fef4198e8ad1eedfbb93c252`.
The Apache-2.0 Brush source directly embeds it using `include_bytes!`. The model
contains VGG16 convolution blocks and learned LPIPS heads. Loss weight zero avoids
initializing the model, but did not prevent the resource from entering .1–.4 binaries.

The pinned Rust converter reads local `lpips_vgg_remapped.pth`, maps parameters to
f16 and writes `burn_mapped.bpk`. Git history includes initial packed weights in
`97174d819c7c717fcb2f40fcc608a5c5cc3f05ee`, a recorder update in
`6bbef62aa69a2851b630957e0f396b2659c70f50`, and the current Burn conversion in
`3da02ecfe91aae9c011a8c8c482d82860b88eb1f`. That history does not supply the local
PyTorch input, its source hashes, or a reproducible original-to-remapped conversion
script. The numerical reference test is not evidence of that input's identity.

The likely upstream architecture is documented by the primary sources below:

- [PerceptualSimilarity LICENSE](https://github.com/richzhang/PerceptualSimilarity/blob/master/LICENSE)
  is BSD-2-Clause and requires retained notices for source/binary redistribution.
  Audited Git blob: `e269c6bdc77eecf327fd72b156b7ec3b6434066c`.
- [LPIPS loader](https://github.com/richzhang/PerceptualSimilarity/blob/master/lpips/lpips.py)
  loads its learned heads from `weights/v{version}/{net}.pth` separately from the
  backbone. Audited blob: `93595476718931631883768f69d2f3a68f3bee34`.
- [LPIPS VGG backbone](https://github.com/richzhang/PerceptualSimilarity/blob/master/lpips/pretrained_networks.py)
  calls Torchvision's pretrained VGG16. Audited blob:
  `a70ebbeab1618da4fe2538833f049dc569f1eea1`.
- [Torchvision README, Pre-trained Model License](https://github.com/pytorch/vision/blob/main/README.md#pre-trained-model-license)
  says pretrained models may have their own licenses/terms derived from training
  datasets. Its BSD-3-Clause code license alone therefore does not establish
  permission for this specific BPK. Audited README blob:
  `624dbfc6bf3c8abeb3ade96c124b0fcc5766b4ca`.

The fetched source texts and identities are preserved under
`target/macos-m4/brush-evidence/license-sources/`. We have not demonstrated that
these upstream weights, versions and hashes are exactly the ones in the BPK.
Nor have we established the complete redistribution terms for that exact chain.
The Brush project's Apache-2.0 declaration is not substituted for that evidence.

## Implemented distribution policy

`metorigin-macos.5` keeps the .4 live/checkpoint implementation and excludes LPIPS
from the default CLI dependency graph. `lpips/embedded-weights` gates the only
`include_bytes!`; `brush-cli/embedded-lpips` forwards an explicit opt-in through the
process/training crates. Neither feature is enabled by the macOS build recipe.
The existing file stays in the isolated upstream checkout; it is not copied into
the app's distribution artifacts.

The default binary rejects positive LPIPS weights before training. The merged
`args.txt` configuration is validated as well, and explicit `--lpips-loss-weight 0`
retains normal CLI precedence. Negative and nonfinite weights are rejected.
Capabilities report both `embedded_weights=false` and `loss_available=false`.
The public trainer also checks configuration before creating optimizer tensors.

The opt-in feature is not an authorization to redistribute weights. It exists for
controlled development only. Re-enabling it for distribution requires identifying
both original weight components, exact versions/hashes, remapping inputs and
commands, and all applicable permissions/notices. .3/.4 remain preserved research
artifacts and must not be selected as the default distribution build.

`check-brush-distribution.py` checks the actual default target dependency tree,
compiled capabilities, complete packed payload, and 64 separated 4 KiB payload
samples. This establishes the selected binary's exclusion of the known packed
resource; it is not a general license certification for all dependencies. The
packaging license/SBOM audit covers that remaining dependency graph separately.
