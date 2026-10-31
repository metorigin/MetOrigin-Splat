import { t, getLocale } from "../../i18n";
import type { ResourceMetrics } from "../../types";

function bytes(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? t("尚未测量") : `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
function pressure(value: ResourceMetrics["memory"]) {
  return value?.pressure === "normal" ? t("正常") : value?.pressure === "warning" ? t("偏高") : value?.pressure === "critical" ? t("严重") : t("尚未测量");
}
const roleLabel = (role: string) => role === "application" ? t("应用") : role === "brush" ? "Brush" : role === "colmap" ? "COLMAP" : role === "webview2" ? "WebView2" : "WebKit";

export function RuntimeResources({ metrics }: { metrics: ResourceMetrics | null }) {
  const runtime = metrics?.runtime;
  const effective = runtime?.effective_training;
  const requested = runtime?.requested_preset;
  const preset = requested === "fast" ? t("快速") : requested === "balanced" ? t("均衡") : requested === "quality" ? t("高质量") : requested ?? t("尚未测量");
  return <section className="space-y-4 text-sm [&_h2]:text-sm [&_h2]:font-semibold [&_dl]:space-y-3 [&_dl>div]:grid [&_dl>div]:grid-cols-2 [&_dl>div]:gap-4 [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:text-right [&_dd]:tabular-nums [&_dd]:break-words" aria-label={t("运行资源配置")}>
    <h2>{t("运行资源配置")}</h2>
    <dl>
      <div><dt>COLMAP</dt><dd>{runtime?.colmap_backend ?? t("尚未测量")}</dd></div>
      <div><dt>Brush</dt><dd>{runtime ? `${runtime.brush_backend}${runtime.device_name ? ` · ${runtime.device_name}` : ""}` : t("尚未测量")}</dd></div>
      <div><dt>{t("请求预设")}</dt><dd>{preset}</dd></div>
      <div><dt>{t("实际训练参数")}</dt><dd>{effective ? `${effective.iterations.toLocaleString(getLocale())} steps · SH${effective.sh_degree} · ${effective.resolution ?? "—"} px` : t("尚未测量")}</dd></div>
      <div><dt>{t("图像缓存上限")}</dt><dd>{bytes(effective?.image_cache_budget_bytes)}</dd></div>
      <div><dt>{t("高斯数量上限")}</dt><dd>{effective?.max_splats?.toLocaleString(getLocale()) ?? t("尚未测量")}</dd></div>
      <div><dt>{t("加载线程")}</dt><dd>{effective?.threads ?? t("尚未测量")}</dd></div>
      <div><dt>{t("训练资源预算")}</dt><dd>{bytes(runtime?.training_budget_bytes)}</dd></div>
      {metrics?.memory?.kind === "unified" && <>
        <div><dt>{metrics.memory.available_is_estimate ? t("可回收内存估算") : t("系统可用内存")}</dt><dd>{bytes(metrics.memory.available_bytes)}</dd></div>
        {metrics.memory.available_is_estimate && <>
          <div><dt>{t("空闲内存")}</dt><dd>{bytes(metrics.memory.free_bytes)}</dd></div>
          <div><dt>{t("非活跃内存")}</dt><dd>{bytes(metrics.memory.inactive_bytes)}</dd></div>
          <div><dt>{t("压缩内存")}</dt><dd>{bytes(metrics.memory.compressed_bytes)}</dd></div>
        </>}
        <div><dt>{t("系统内存压力")}</dt><dd>{pressure(metrics.memory)}</dd></div>
        <div><dt>Swap</dt><dd>{bytes(metrics.memory.swap_used_bytes)} / {bytes(metrics.memory.swap_total_bytes)}</dd></div>
        <div><dt>{t("Metal 建议工作集")}</dt><dd>{bytes(runtime?.recommended_working_set_bytes)}</dd></div>
      </>}
      {metrics?.memory?.kind === "system" && <>
        <div><dt>{t("系统可用内存")}</dt><dd>{bytes(metrics.memory.available_bytes)}</dd></div>
        <div><dt>{t("训练设备可用预算")}</dt><dd>{bytes(runtime?.recommended_working_set_bytes)}</dd></div>
      </>}
    </dl>
    {metrics?.memory?.available_is_estimate && <p className="text-xs leading-relaxed text-muted-foreground">{t("估算来自系统空闲与非活跃内存，不重复扣减压缩内存。它不是可保证的分配额度，预览仍优先遵循系统内存压力。")}</p>}
    <p className="text-xs leading-relaxed text-muted-foreground">{metrics?.memory?.kind === "system" ? t("资源预算是训练策略，不是分配保证；系统内存和训练设备显存分别观测，缺失指标保持未知。") : t("资源预算是训练策略，不是进程内存硬上限；统一内存由系统、训练和预览共享。")}</p>
    {metrics?.processes?.length ? <>
      <h2>{t("进程驻留内存")}</h2>
      <dl>{metrics.processes.map((process) => <div key={process.pid}><dt>{roleLabel(process.role)}</dt><dd>{bytes(process.resident_bytes)}</dd></div>)}</dl>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("RSS 可能包含共享页，不能相加。未归属的 WebKit 进程不计入，缺失指标保持未知。")}</p>
    </> : null}
  </section>;
}
