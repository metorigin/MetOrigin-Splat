import {
  CaretDown,
  CheckCircle,
  FilmStrip,
  FolderOpen,
  Gauge,
  Images,
  SpinnerGap,
  Warning,
  X
} from "@/components/primitives/icons";
import { getLocale, localizeMessage, t } from "@/i18n";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Notification } from "@/components/feedback";
import type {
  ImagePreview,
  MediaAnalysis,
  PresetEstimate,
  ProjectPreflight
} from "@/types";



import type { DirectoryCheckState } from "./wizardPresentation";
import { formatBytes, formatDuration, macExecutionSummary, presetDescription, presetLabel } from "./wizardPresentation";

export function ImportStep({ analysis, analyzing, analyzingKind, estimate, imagePreviews, previewsLoading, previewError, onChoose, onClear }: {
  analysis: MediaAnalysis | null;
  analyzing: boolean;
  analyzingKind: "video" | "images" | null;
  estimate: PresetEstimate | null;
  imagePreviews: ImagePreview[];
  previewsLoading: boolean;
  previewError: string | null;
  onChoose: (kind: "video" | "images") => Promise<void>;
  onClear: () => void;
}) {
  return (
    <section className="space-y-5">
      <header className="space-y-1"><h2 id="wizard-step-heading-0" tabIndex={-1} className="text-base font-semibold">{t("选择重建素材")}</h2><p className="text-sm text-muted-foreground">{t("导入一段连续视频或一组围绕目标拍摄的照片。")}</p></header>
      <div className="min-w-0 space-y-4">
      {!analysis ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>button]:h-auto [&>button]:min-h-20 [&>button]:justify-start [&>button]:gap-3 [&>button]:whitespace-normal [&>button]:rounded-lg [&>button]:px-4 [&>button]:py-4 [&>button]:text-left [&>button>svg]:size-5 [&>button>svg]:text-muted-foreground [&_strong]:block [&_strong]:text-sm [&_strong]:font-medium [&_small]:mt-1 [&_small]:block [&_small]:text-xs [&_small]:font-normal [&_small]:text-muted-foreground">
            <Button variant="outline" type="button" onClick={() => void onChoose("video")} disabled={analyzing}><FilmStrip size={20} /><span><strong>{t("选择视频")}</strong><small>MP4、MOV、AVI、MKV</small></span></Button>
            <Button variant="outline" type="button" onClick={() => void onChoose("images")} disabled={analyzing} aria-describedby="image-folder-selection-hint"><Images size={20} /><span><strong>{t("选择图片文件夹")}</strong><small>{t("浏览 JPG、JPEG、PNG 图片")}</small></span></Button>
          </div>
          <p id="image-folder-selection-hint" className="text-xs leading-relaxed text-muted-foreground">{t("选择任意一张图片，即可导入其所在文件夹及子文件夹中的全部有效图片。")}</p>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
            <span className={analysis.valid ? "text-success" : "text-destructive"}>{analysis.valid ? <CheckCircle size={20} /> : <Warning size={20} />}</span>
            <div className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium" title={analysis.display_name}>{analysis.display_name}</strong><span className="mt-1 block truncate text-xs text-muted-foreground" title={analysis.source_path}>{analysis.source_path}</span></div>
            <Button variant="outline" size="sm" className="rounded-md" type="button" onClick={() => void onChoose(analysis.source_kind)}>{t("替换素材")}</Button>
            <Button variant="ghost" size="icon-sm" type="button" onClick={onClear} aria-label={t("清除素材")}><X size={17} /></Button>
          </div>
          {analysis.video_metadata ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label={t("分辨率")} value={`${analysis.video_metadata.width} × ${analysis.video_metadata.height}`} />
              <Metric label={t("帧率")} value={`${analysis.video_metadata.fps.toFixed(2)} fps`} />
              <Metric label={t("时长")} value={formatDuration(analysis.video_metadata.duration_seconds)} />
              <Metric label={t("编码")} value={analysis.video_metadata.codec.toUpperCase()} />
              <Metric label={t("源帧数")} value={analysis.video_metadata.frame_count ? analysis.video_metadata.frame_count.toLocaleString(getLocale()) : t("尚未测量")} />
              <Metric label={t("文件大小")} value={formatBytes(analysis.size_bytes)} />
            </div>
          ) : analysis.image_set_metadata ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
              <Metric label={t("有效图片")} value={t("{0} 张", analysis.image_set_metadata.image_count)} />
              <Metric label={t("实际使用")} value={t("{0} 张", estimate?.estimated_frames ?? analysis.image_set_metadata.image_count)} />
              <Metric label={t("目标最长边")} value={t("{0}px（只缩小）", estimate?.target_long_edge ?? 0)} />
              <Metric label={t("忽略文件")} value={t("{0} 个", analysis.image_set_metadata.ignored_count)} />
              <Metric label={t("损坏图片")} value={t("{0} 张", analysis.image_set_metadata.invalid_count)} />
              <Metric label={t("总大小")} value={formatBytes(analysis.image_set_metadata.total_size_bytes)} />
              <Metric label={t("格式")} value={Object.entries(analysis.image_set_metadata.formats).map(([format, count]) => `${format.toUpperCase()} ${count}`).join(" / ")} />
            </div>
          ) : null}
          {analysis.source_kind === "images" && (
            <div className="space-y-3 border-t border-border pt-3" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm [&>span]:text-xs [&>span]:text-muted-foreground"><strong>{t("图片预览")}</strong><span>{t("抽样预览")}</span></div>
              {previewsLoading ? (
                <div className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground"><SpinnerGap className="animate-spin motion-reduce:animate-none" size={17} />{t("正在生成安全缩略图…")}</div>
              ) : previewError ? (
                <Notification variant="error" message={localizeMessage(previewError)} />
              ) : imagePreviews.length > 0 ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  {imagePreviews.map((preview) => <ImagePreviewTile key={preview.relative_path} preview={preview} />)}
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md bg-muted p-3 text-sm text-muted-foreground">{t("没有可显示的缩略图。")}</div>
              )}
            </div>
          )}
          {analysis.preset_estimates.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground [&_strong]:mr-2 [&_strong]:font-medium [&_strong]:text-foreground">
              {analysis.preset_estimates.map((preset) => <span key={preset.id}><strong>{presetLabel(preset.id)}</strong>{t("预计 {0} 帧", preset.estimated_frames)}</span>)}
            </div>
          )}
          {analysis.warnings.length > 0 ? (
            <section className="space-y-2 [&>h3]:text-sm [&>h3]:font-medium" aria-label={t("可以继续的提醒")}>
              <h3>{t("可以继续的提醒")}</h3>
              {analysis.warnings.map((warning) => <Notification variant="warning" key={warning} message={localizeMessage(warning)} />)}
            </section>
          ) : null}
          {analysis.blockers.length > 0 ? (
            <section className="space-y-2 [&>h3]:text-sm [&>h3]:font-medium [&>h3]:text-destructive" aria-label={t("需要处理的问题")}>
              <h3>{t("需要处理后才能继续")}</h3>
              {analysis.blockers.map((blocker) => <Notification variant="error" role="status" key={blocker} message={localizeMessage(blocker)}><p>{t("请重新选择可读取的素材后再次分析。")}</p></Notification>)}
            </section>
          ) : null}
        </div>
      )}
      {analyzing && <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground"><SpinnerGap className="animate-spin motion-reduce:animate-none" size={18} />{analyzingKind === "images" ? t("正在递归扫描并验证图片…") : t("正在调用 FFprobe 读取真实媒体信息…")}</div>}
      </div>
      <Collapsible className="border-t border-border pt-2">
        <CollapsibleTrigger asChild><Button variant="ghost" type="button" className="h-9 w-full justify-between rounded-md px-2 text-sm text-muted-foreground [&[data-state=open]>svg]:rotate-180">{t("拍摄建议")}<CaretDown size={14} /></Button></CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 px-2 pb-2 pt-3 text-xs leading-relaxed text-muted-foreground">
        <ol className="grid list-decimal gap-x-6 gap-y-2 pl-4 sm:grid-cols-2">
          <li>{t("保持 70% 以上画面重叠")}</li>
          <li>{t("围绕静止主体缓慢移动，避免跳跃")}</li>
          <li>{t("锁定曝光并减少动态物体")}</li>
          <li>{t("补拍顶部、背面和遮挡区域")}</li>
        </ol>
        <p>{t("建议 80–500 张图像，单次导入不超过 20 GB")}</p>
        <p>{t("素材默认仅在本机处理")}</p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function ImagePreviewTile({ preview }: { preview: ImagePreview }) {
  const [failed, setFailed] = useState(!preview.data_url);
  return (
    <figure className="min-w-0 [&>div]:flex [&>div]:aspect-[4/3] [&>div]:items-center [&>div]:justify-center [&>div]:overflow-hidden [&>div]:rounded-md [&>div]:bg-muted [&_img]:size-full [&_img]:object-cover [&_figcaption]:mt-1 [&_figcaption]:space-y-0.5 [&_figcaption>strong]:block [&_figcaption>strong]:truncate [&_figcaption>strong]:text-xs [&_figcaption>strong]:font-medium [&_figcaption>span]:block [&_figcaption>span]:text-[11px] [&_figcaption>span]:text-muted-foreground [&_div>span]:flex [&_div>span]:items-center [&_div>span]:gap-1 [&_div>span]:text-xs [&_div>span]:text-muted-foreground">
      <div>{failed ? <span><Warning size={18} />{t("无法解码")}</span> : <img src={preview.data_url} alt={preview.display_name} onError={() => setFailed(true)} />}</div>
      <figcaption><strong title={preview.relative_path}>{preview.display_name}</strong><span>{preview.width} × {preview.height}</span></figcaption>
    </figure>
  );
}

export function PreflightStep({ analysis, preflight, checking, selectedPreset, onSelectPreset, onRecheck, onOpenSettings }: {
  analysis: MediaAnalysis | null;
  preflight: ProjectPreflight | null;
  checking: boolean;
  selectedPreset: string;
  onSelectPreset: (id: string) => void;
  onRecheck: () => void;
  onOpenSettings?: () => void;
}) {
  const selectedEstimate = analysis?.preset_estimates.find((preset) => preset.id === selectedPreset);
  const effectiveFrameCount = selectedEstimate?.estimated_frames ?? preflight?.estimated_frames;
  const resolution = analysis?.video_metadata ? `${analysis.video_metadata.width} × ${analysis.video_metadata.height}` : t("原始分辨率");
  const warnings = [...new Set([...(analysis?.warnings ?? []), ...(preflight?.warnings ?? [])])];
  const [environmentOpen, setEnvironmentOpen] = useState(preflight?.can_continue === false);
  useEffect(() => {
    if (preflight?.can_continue === false) setEnvironmentOpen(true);
  }, [preflight?.can_continue]);
  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1"><h2 id="wizard-step-heading-1" tabIndex={-1} className="text-base font-semibold">{t("素材分析结果")}</h2><p className="truncate text-sm text-muted-foreground" title={analysis?.source_path}>{analysis?.display_name ?? t("等待素材分析")}</p></div>
        <Badge variant={checking ? "secondary" : preflight?.can_continue ? "success" : "destructive"}>{checking ? t("检查中") : preflight?.can_continue ? t("已完成") : t("需处理")}</Badge>
      </header>

      <section className="space-y-3" aria-labelledby="wizard-presets-heading">
        <div className="space-y-1"><h3 id="wizard-presets-heading" className="text-sm font-medium">{t("重建预设")}</h3><p className="text-xs text-muted-foreground">{t("选择处理帧数、分辨率与训练迭代次数。")}</p></div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {analysis?.preset_estimates.map((preset) => (
            <Button type="button" key={preset.id} variant={selectedPreset === preset.id ? "default" : "outline"} aria-pressed={selectedPreset === preset.id} className={cn("h-auto w-full flex-col items-stretch justify-start gap-3 whitespace-normal rounded-lg p-4 text-left [&>span]:text-xs [&>span]:font-normal [&>span]:leading-relaxed [&>span:first-child]:flex [&>span:first-child]:items-center [&>span:first-child]:justify-between [&_strong]:text-sm [&_strong]:font-medium [&_em]:ml-2 [&_em]:text-xs [&_em]:font-normal [&_em]:not-italic", selectedPreset === preset.id ? "ring-2 ring-primary ring-offset-2 ring-offset-background [&>span]:text-primary-foreground [&_strong]:text-primary-foreground [&_em]:text-primary-foreground" : "[&>span]:text-muted-foreground [&_strong]:text-foreground [&_em]:text-primary")} onClick={() => onSelectPreset(preset.id)}>
              <span><strong>{presetLabel(preset.id)}{preset.id === "balanced" && <em>{t("推荐")}</em>}</strong><small className="flex items-center gap-1">{selectedPreset === preset.id ? <><CheckCircle size={14} />{t("已选择")}</> : t("选择")}</small></span>
              <span>{preset.estimated_frames} {t("帧 ·")}{preset.iterations.toLocaleString(getLocale())} {t("次迭代 · 约")}{formatBytes(preset.estimated_disk_bytes)}</span>
              <span>{presetDescription(preset.id, preset.description)}</span>
            </Button>
          ))}
        </div>
        <Collapsible className="border-b border-border pb-2">
          <CollapsibleTrigger asChild><Button variant="ghost" type="button" className="h-9 w-full justify-between gap-3 rounded-md px-2 text-sm text-muted-foreground [&[data-state=open]>svg]:rotate-180">{t("参数详情")}<span className="ml-auto text-xs font-normal">{t("当前预设")}</span><CaretDown size={14} /></Button></CollapsibleTrigger>
          <CollapsibleContent>
            {selectedEstimate ? <div className="grid grid-cols-1 gap-x-5 gap-y-2 px-2 py-3 text-xs leading-relaxed text-muted-foreground sm:grid-cols-2"><div>{t("训练最长边：")}{selectedEstimate.target_long_edge} px</div><div>{t("相机重建最长边：")}{selectedEstimate.colmap_long_edge} px</div><div>{t("检查点间隔：")}{selectedEstimate.checkpoint_interval} {t("次迭代")}</div><div>{t("球谐阶数：")}{selectedEstimate.sh_degree}</div></div> : null}
            <div className="grid grid-cols-1 gap-3 border-t border-border px-2 py-3 sm:grid-cols-3">
              <Metric label={t("预计处理帧数")} value={effectiveFrameCount?.toLocaleString(getLocale()) ?? "—"} detail={t("根据素材与所选预设估算")} />
              <Metric label={t("源分辨率")} value={resolution} detail={t("保留原始长宽比")} />
              <Metric label={t("训练迭代")} value={selectedEstimate?.iterations.toLocaleString(getLocale()) ?? "—"} detail={t("预设目标次数")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("磁盘用量为预估值。训练耗时与显存占用以实际运行数据为准。")}</p>
      </section>
      <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-labelledby="wizard-preflight-heading">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="wizard-preflight-heading" className="text-sm font-medium">{t("预检结果")}</h3><Button type="button" variant="outline" size="sm" className="rounded-md" onClick={onRecheck} disabled={checking}>{checking ? t("检查中…") : t("重新检查")}</Button></div>
        {checking && <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><SpinnerGap className="animate-spin motion-reduce:animate-none" size={16} />{t("正在按当前预设检查磁盘空间与运行环境…")}</p>}

        {warnings.map((warning) => {
          const executionSummary = macExecutionSummary(warning);
          return <Notification variant="warning" key={warning} message={<span title={executionSummary ? localizeMessage(warning) : undefined}>{executionSummary ?? localizeMessage(warning)}</span>} />;
        })}
        {preflight?.blockers.length ? (
          <section className="space-y-2 [&>h3]:text-sm [&>h3]:font-medium [&>h3]:text-destructive" aria-label={t("需要处理的问题")}>
            <h3>{t("需要处理后才能继续")}</h3>
            {preflight.blockers.map((blocker) => <Notification variant="error" role="status" key={blocker} message={localizeMessage(blocker)}><p>{t("修复相关组件、显卡环境或保存位置后重新检查。")}</p></Notification>)}
            <div className="flex flex-wrap gap-2">
              {onOpenSettings ? <Button type="button" variant="outline" onClick={onOpenSettings}>{t("打开设置")}</Button> : null}
            </div>
          </section>
        ) : null}
        <Collapsible open={environmentOpen} onOpenChange={setEnvironmentOpen} className="border-t border-border pt-2">
          <CollapsibleTrigger asChild><Button variant="ghost" type="button" className="h-9 w-full justify-between rounded-md px-2 text-sm text-muted-foreground [&[data-state=open]>svg]:rotate-180">{t("运行环境详情")}<CaretDown size={14} /></Button></CollapsibleTrigger>
          <CollapsibleContent className="px-2 pt-3">
            <div className="divide-y divide-border [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-3 [&>div]:py-2 [&>div:first-child]:pt-0 [&>div:last-child]:pb-0 [&_strong]:text-sm [&_strong]:font-medium [&_small]:mt-0.5 [&_small]:block [&_small]:break-words [&_small]:text-xs [&_small]:text-muted-foreground">
              <div><span className="min-w-0"><strong>{t("素材可用性")}</strong><small>{analysis?.valid ? t("素材格式与读取检查通过") : t("等待素材检查")}</small></span><Badge variant={analysis?.valid ? "success" : "secondary"}>{analysis?.valid ? t("通过") : t("待检查")}</Badge></div>
              {(preflight?.engine_checks ?? []).map((engine) => <div key={engine.name}><span className="min-w-0"><strong>{engine.name}</strong>{engine.actual_version ? <small>{engine.actual_version}</small> : null}<small>{localizeMessage(engine.diagnostic) ?? (engine.available ? t("组件检查通过") : t("未通过组件检查"))}</small></span><Badge variant={engine.available ? "success" : "destructive"}>{engine.available ? t("就绪") : t("不可用")}</Badge></div>)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>
    </section>
  );
}

export function ConfirmStep({ analysis, estimate, preflight, directoryCheck, projectName, projectRoot, onNameChange, onChooseRoot }: {
  analysis: MediaAnalysis;
  estimate: PresetEstimate;
  preflight: ProjectPreflight | null;
  directoryCheck: DirectoryCheckState;
  projectName: string;
  projectRoot: string | null;
  onNameChange: (value: string) => void;
  onChooseRoot: () => Promise<void>;
}) {
  return (
    <section className="space-y-5">
      <header><h2 id="wizard-step-heading-2" tabIndex={-1} className="text-base font-semibold">{t("确认创建")}</h2></header>
      <div className="divide-y divide-border border-y border-border">
        <div className="grid items-center gap-3 py-4 sm:grid-cols-[120px_minmax(0,1fr)]"><Label htmlFor="new-project-name">{t("项目名称")}</Label><Input id="new-project-name" className="rounded-md" value={projectName} maxLength={80} onChange={(event) => onNameChange(event.target.value)} placeholder={t("例如：自行车街景测试")} autoFocus /></div>
        <div className="grid gap-3 py-4 sm:grid-cols-[120px_minmax(0,1fr)]">
          <span className="text-sm font-medium sm:pt-2" id="project-root-label">{t("项目保存位置")}</span>
          <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2" aria-labelledby="project-root-label">
            <span className="min-w-0 flex-1 truncate text-sm" title={projectRoot ?? undefined}>{projectRoot ?? t("文档 / MetOrigin Projects（默认）")}</span>
            <Button variant="outline" size="sm" className="rounded-md" type="button" onClick={() => void onChooseRoot()} disabled={directoryCheck.status === "checking"}><FolderOpen size={16} />{t("更改目录")}</Button>
          </div>
          {directoryCheck.status !== "idle" && (
            <Notification
              variant={directoryCheck.status === "error" ? "error" : directoryCheck.status === "success" ? "success" : "info"}
              title={directoryCheck.status === "checking" ? t("正在检查新目录") : directoryCheck.status === "success" ? t("新目录可用") : t("新目录不可用")}
              message={directoryCheck.message ? localizeMessage(directoryCheck.message) : undefined}
              actions={directoryCheck.status === "error" ? <Button variant="outline" type="button" onClick={() => void onChooseRoot()}>{t("重新选择目录")}</Button> : undefined}
            />
          )}
          {directoryCheck.status === "error" && preflight?.blockers.map((blocker) => (
            <Notification variant="error" role="status" key={blocker} message={localizeMessage(blocker)} />
          ))}
          </div>
        </div>
      </div>
      <dl className="divide-y divide-border [&>div]:grid [&>div]:grid-cols-[100px_minmax(0,1fr)] [&>div]:gap-3 [&>div]:py-3 sm:[&>div]:grid-cols-[120px_minmax(0,1fr)] [&_dt]:flex [&_dt]:items-center [&_dt]:gap-2 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words [&_dd]:text-sm">
        <div><dt>{analysis.source_kind === "images" ? <Images size={16} /> : <FilmStrip size={16} />}{t("素材")}</dt><dd title={analysis.source_path}>{analysis.display_name}</dd></div>
        <div><dt><Gauge size={16} />{t("质量方案")}</dt><dd>{presetLabel(estimate.id)} · {estimate.estimated_frames} {t("帧 ·")}{estimate.iterations.toLocaleString(getLocale())} {t("次训练")}</dd></div>
        <div><dt><FolderOpen size={16} />{t("复制方式")}</dt><dd>{t("复制到项目（")}{formatBytes(analysis.size_bytes)}）</dd></div>
      </dl>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="min-w-0 space-y-1 [&>span]:block [&>span]:text-xs [&>span]:text-muted-foreground [&>strong]:block [&>strong]:break-words [&>strong]:text-sm [&>strong]:font-medium [&>strong]:tabular-nums [&>small]:block [&>small]:text-xs [&>small]:text-muted-foreground"><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</div>;
}
