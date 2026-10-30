import type { ResourceMetrics } from "../types";

/** Apple unified RAM is system memory, never dedicated GPU VRAM. */
export function resourceMemory(metrics: ResourceMetrics | null | undefined) {
  const unified = metrics?.memory?.kind === "unified";
  return {
    unified,
    used: unified ? metrics?.memory_used_bytes ?? null : metrics?.gpu?.memory_used_bytes ?? null,
    total: unified ? (metrics?.memory_total_bytes || null) : metrics?.gpu?.memory_total_bytes ?? null,
  };
}
