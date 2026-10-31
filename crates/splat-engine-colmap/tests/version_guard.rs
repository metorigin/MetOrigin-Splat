//! Execute a native fixture on Windows as well as Unix. A successful `-h`
//! alone must never authorize a command that could upgrade an existing DB.
use std::path::{Path, PathBuf};
use std::process::Command;

use splat_domain::runtime::ExecutionProfile;
use splat_engine_colmap::{ColmapAdapter, ColmapExecutionSettings};

const FIXTURE: &str = r#"
fn main() {
    use std::io::Write;
    let root = std::env::current_exe().unwrap().parent().unwrap().to_owned();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut calls = std::fs::OpenOptions::new().create(true).append(true)
        .open(root.join("calls.txt")).unwrap();
    writeln!(calls, "{}", args.join(" ")).unwrap();
    if args != ["-h"] {
        std::fs::write(root.join("database.db"), b"migrated by incompatible engine").unwrap();
        std::process::exit(99);
    }
    let mode = std::fs::read_to_string(root.join("mode.txt")).unwrap();
    let (version, code) = mode.trim().split_once('|').unwrap();
    eprintln!("COLMAP {} (version guard fixture)", version);
    std::process::exit(code.parse().unwrap());
}
"#;

fn compile_fixture(root: &Path) -> PathBuf {
    let source = root.join("fixture.rs");
    std::fs::write(&source, FIXTURE).unwrap();
    let executable = root.join(if cfg!(windows) {
        "colmap.exe"
    } else {
        "colmap"
    });
    let output = Command::new("rustc")
        .arg("--edition=2021")
        .arg("--crate-name=colmap_guard_fixture")
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    executable
}

#[test]
fn every_constructor_rejects_incompatible_help_before_touching_existing_database() {
    let dir = tempfile::Builder::new()
        .prefix("colmap guard 中文 ")
        .tempdir()
        .unwrap();
    let executable = compile_fixture(dir.path());
    let database = dir.path().join("database.db");
    // Preserve a real old-style SQLite camera table, including its exact bytes.
    // Rejection must precede engine access or automatic schema migration.
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cameras(camera_id INTEGER PRIMARY KEY, model INTEGER NOT NULL, \
             width INTEGER NOT NULL, height INTEGER NOT NULL, params BLOB, \
             prior_focal_length INTEGER NOT NULL); \
             INSERT INTO cameras VALUES(1, 0, 640, 480, X'00000000', 1);",
            )
            .unwrap();
    }
    let original = std::fs::read(&database).unwrap();
    let profile = ExecutionProfile::from_json(include_bytes!(
        "../../../schemas/examples/execution-profile/macos.valid.json"
    ))
    .unwrap();
    let settings = ColmapExecutionSettings::from_execution_profile(&profile).unwrap();

    for (version, exit, error) in [
        ("4.3.0.dev0", 0, "E-3006"),
        ("4.3.0", 0, "E-3006"),
        ("unknown", 0, "E-3006"),
        ("4.1.0-rc.1", 0, "E-3006"),
        ("4.1.0", 1, "E-3002"),
    ] {
        std::fs::write(dir.path().join("mode.txt"), format!("{version}|{exit}")).unwrap();
        for result in [
            ColmapAdapter::from_path(executable.clone()),
            ColmapAdapter::from_path_with_settings(executable.clone(), settings.clone()),
            ColmapAdapter::from_path_with_profile(executable.clone(), &profile),
        ] {
            assert_eq!(result.err().unwrap().code, error, "{version}");
            assert_eq!(std::fs::read(&database).unwrap(), original);
        }
    }

    std::fs::write(dir.path().join("mode.txt"), "4.1.0|0").unwrap();
    let adapter = ColmapAdapter::from_path(executable.clone()).unwrap();
    adapter.validate().unwrap();
    ColmapAdapter::from_path_with_settings(executable, settings).unwrap();
    // Revalidation also protects a binary replaced after its initial detection.
    std::fs::write(dir.path().join("mode.txt"), "4.3.0|0").unwrap();
    assert_eq!(adapter.validate().unwrap_err().code, "E-3006");
    assert_eq!(std::fs::read(&database).unwrap(), original);
    let calls = std::fs::read_to_string(dir.path().join("calls.txt")).unwrap();
    assert!(calls.lines().count() >= 19);
    assert!(calls.lines().all(|call| call == "-h"));
}
