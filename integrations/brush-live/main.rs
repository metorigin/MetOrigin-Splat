#![recursion_limit = "256"]
// Headless Brush 0.3.0 entry point. Built inside the pinned upstream workspace.
use brush_cli::Cli;
use brush_process::process::process_stream;
use clap::Parser;

fn main() -> anyhow::Result<()> {
    let args = Cli::parse().validate()?;
    if args.with_viewer {
        anyhow::bail!("brush_live is the embedded preview engine; use brush_app for the native viewer");
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(async move {
        env_logger::builder().target(env_logger::Target::Stdout).init();
        let source = args.source.ok_or_else(|| anyhow::anyhow!("A training source is required"))?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let _ = sender.send(args.process.clone());
        let device = brush_render::burn_init_setup().await;
        brush_cli::process_ui(process_stream(source, receiver, device), args.process).await
    })
}
