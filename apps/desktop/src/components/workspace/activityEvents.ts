import type { PipelineEventRecord } from "../../types";

export function mergeActivityEvents(
  current: PipelineEventRecord[],
  incoming: PipelineEventRecord[],
): PipelineEventRecord[] {
  const byIdentity = new Map<string, PipelineEventRecord>();
  for (const event of [...current, ...incoming]) {
    const key = event.event_id || `${event.project_id}:${event.sequence}`;
    const existing = byIdentity.get(key);
    if (!existing || event.sequence >= existing.sequence) byIdentity.set(key, event);
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.sequence - right.sequence || left.timestamp.localeCompare(right.timestamp),
  );
}
