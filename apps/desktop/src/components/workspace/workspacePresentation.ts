import type { FramePreview, PipelineStageId, SparsePreviewPack } from "@/types";
export type StagePreview =
  | { requestKey: string; stageId: PipelineStageId; kind: "frame"; value: FramePreview }
  | { requestKey: string; stageId: PipelineStageId; kind: "sparse"; value: SparsePreviewPack };

export const GAUSSIAN_STAGES: readonly string[] = ["TrainingPreparation", "BrushTraining", "ModelValidation", "Export", "PreviewGeneration"];
export const TRAINING_PREVIEW_STAGES: readonly string[] = ["TrainingPreparation", "BrushTraining", "ModelValidation"];
export const FRAME_PREVIEW_STAGES: readonly string[] = ["MediaValidation", "FrameExtraction", "ImagePreprocessing"];
export const SPARSE_PREVIEW_STAGES: readonly string[] = ["ColmapFeatureExtraction", "ColmapMatching", "ColmapMapping", "ColmapValidation"];
