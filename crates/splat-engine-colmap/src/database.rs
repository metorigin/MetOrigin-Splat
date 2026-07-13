use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::CommandSpec;

/// Creates and manages the COLMAP SQLite database.
///
/// Responsible for:
/// - Building the `colmap database_creator` command
/// - Validating that the database was created successfully
/// - Cleaning up database files before re-running
pub struct DatabaseCreator {
    colmap_path: PathBuf,
}

impl DatabaseCreator {
    /// Create a new database creator with the path to the COLMAP executable.
    pub fn new(colmap_path: PathBuf) -> Self {
        Self { colmap_path }
    }

    /// Build the `colmap database_creator` command.
    ///
    /// Generates a `CommandSpec` that can be executed via `ProcessRunner`:
    ///
    /// ```bash
    /// colmap database_creator --database_path <database_path>
    /// ```
    pub fn build_command(&self, database_path: &Path, log_path: &Path) -> CommandSpec {
        CommandSpec::new(
            &self.colmap_path,
            vec![
                "database_creator",
                "--database_path",
                database_path.to_str().unwrap_or(""),
            ],
            log_path,
        )
    }

    /// Validate that the database was created correctly.
    ///
    /// Checks:
    /// 1. The database file exists
    /// 2. The file is at least 1 KB (SQLite empty database is ~20KB)
    pub fn validate_database(database_path: &Path) -> AppResult<()> {
        if !database_path.exists() {
            return Err(AppError::new(
                "E-3001",
                ErrorCategory::Engine,
                "COLMAP Database Not Created",
                format!(
                    "The COLMAP database was not created at '{}'. \
                     The database_creator command may have failed.",
                    database_path.display()
                ),
            )
            .with_suggestions(vec!["Check the COLMAP log for error messages"]));
        }

        let meta = std::fs::metadata(database_path).map_err(|e| {
            AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "Failed to Read Database",
                format!(
                    "Could not read the database file at '{}': {}",
                    database_path.display(),
                    e
                ),
            )
        })?;

        if meta.len() < 1024 {
            return Err(AppError::new(
                "E-3003",
                ErrorCategory::Engine,
                "Database Too Small",
                format!(
                    "The COLMAP database at '{}' is only {} bytes. \
                     A valid database should be at least 1 KB.",
                    database_path.display(),
                    meta.len()
                ),
            ));
        }

        Ok(())
    }

    /// Remove an existing database and its associated files.
    ///
    /// COLMAP creates several files alongside the database:
    /// - `database.db`
    /// - `database.db-journal`
    /// - `database.db-wal`
    /// - `database.db-shm`
    ///
    /// All of these are removed to ensure a clean state.
    pub fn remove_database(database_path: &Path) -> std::io::Result<()> {
        let extensions = ["", "-journal", "-wal", "-shm"];
        for ext in &extensions {
            let path = if ext.is_empty() {
                database_path.to_path_buf()
            } else {
                let name = format!("{}{}", database_path.to_string_lossy(), ext);
                PathBuf::from(name)
            };
            if path.exists() {
                std::fs::remove_file(&path)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_command_contains_database_creator() {
        let creator = DatabaseCreator::new(PathBuf::from("colmap"));
        let spec = creator.build_command(
            Path::new("/test/project/colmap/database.db"),
            Path::new("/test/project/logs/database.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("database_creator"));
        assert!(args_str.contains("--database_path"));
        assert!(args_str.contains("database.db"));
    }

    #[test]
    fn test_build_command_uses_colmap_path() {
        let creator = DatabaseCreator::new(PathBuf::from("/usr/local/bin/colmap"));
        let spec = creator.build_command(Path::new("db.db"), Path::new("log.log"));
        assert!(spec.program.to_string_lossy().contains("colmap"));
    }

    #[test]
    fn test_validate_nonexistent_database() {
        let result = DatabaseCreator::validate_database(Path::new("/nonexistent/database.db"));
        assert!(result.is_err());
        if let Err(e) = result {
            assert_eq!(e.category, ErrorCategory::Engine);
        }
    }

    #[test]
    fn test_validate_empty_database() {
        let dir = std::env::temp_dir().join("splat-colmap-db");
        let _ = std::fs::create_dir_all(&dir);
        let db_path = dir.join("database.db");

        // Create a too-small file
        std::fs::write(&db_path, [0u8; 100]).unwrap();
        let result = DatabaseCreator::validate_database(&db_path);
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_remove_database_cleanup() {
        let dir = std::env::temp_dir().join("splat-colmap-remove");
        let _ = std::fs::create_dir_all(&dir);
        let db_path = dir.join("database.db");

        // Create database and journal files
        std::fs::write(&db_path, [0u8; 2048]).unwrap();
        let journal = dir.join("database.db-journal");
        std::fs::write(&journal, [0u8; 100]).unwrap();

        assert!(db_path.exists());
        assert!(journal.exists());

        DatabaseCreator::remove_database(&db_path).unwrap();
        assert!(!db_path.exists());
        assert!(!journal.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_remove_nonexistent_database() {
        // Removing a non-existent file should not error
        let result = DatabaseCreator::remove_database(Path::new("/nonexistent/database.db"));
        assert!(result.is_ok());
    }
}
