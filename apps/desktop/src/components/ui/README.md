# Desktop UI source components

These components are maintained as application source. The original registry components were retrieved from [shadcn/ui](https://github.com/shadcn-ui/ui) using CLI 4.23.0 and the `new-york-v4` registry on 2026-10-28. The Jan adaptation merges visual source from [janhq/jan](https://github.com/janhq/jan) fixed commit `b8d58255baf6d9e870025d3f0c60a5b80a63143b`. They use Radix primitives, Tailwind v4 and the shared `@/lib/utils` `cn` helper.

The upstream [MIT license](LICENSE) applies to copied or adapted shadcn/ui source. Jan-derived code also retains [Jan attribution](licenses/jan-LICENSE), [Apache-2.0](licenses/Apache-2.0.txt) and the [modifications record](licenses/jan-MODIFICATIONS.md). This product includes software developed by Menlo Research (https://menlo.ai). The [source manifest](../../../ui-sources.json) records each registry or fixed commit, exact upstream hash and local adaptation. Both platform collectors independently hash the final local bytes.

`resizable.tsx` adapts the shadcn pattern for `react-resizable-panels` 3.0.6. `sidebar.tsx` extracts Jan's controlled surface and width constraints, with local pointer capture, keyboard resize and no Jan stores or cookies. `overlay-context.ts` is application-owned. Project summary numbers are static locale-formatted values. No animation dependency is needed for them.

Before updating components, review upstream differences and preserve these local contracts:

- Buttons default to `type="button"`; destructive and warning states use application tokens.
- Progress exposes the real value or unknown state to Radix accessibility semantics.
- Dialog close labels are localized. `ModalSurface` owns task safety and focus restoration; Radix owns the focus trap.
- Nested menus and tooltips mount in the current modal's accessible subtree.
- All styles use the existing `data-theme` source and must work with reduced motion.

Run the application lint, typecheck, interaction tests and production build after updates, and verify the real Vite development page. Do not infer browser success from unit tests alone. Preserve both upstream license notices in source and distributed notice materials when packaging these components.
