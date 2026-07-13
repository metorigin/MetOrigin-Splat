use splat_domain::error::{AppError, AppResult, ErrorCategory};

/// Current project schema version.
/// Increment this when making breaking changes to `project.json` format.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Migrate project data from `from_version` to `to_version`.
/// Returns the migrated data as a JSON value.
///
/// Currently only schema version 1 is supported. This function will be
/// extended as the project format evolves.
pub fn migrate(
    data: serde_json::Value,
    from_version: u32,
    to_version: u32,
) -> AppResult<serde_json::Value> {
    if from_version == to_version {
        return Ok(data);
    }

    if from_version > to_version {
        return Err(AppError::new(
            "E-1003",
            ErrorCategory::Internal,
            "Version Mismatch",
            format!(
                "Cannot migrate from version {} to {}: target is older than source.",
                from_version, to_version
            ),
        ));
    }

    if from_version == 0 || from_version > CURRENT_SCHEMA_VERSION {
        return Err(AppError::new(
            "E-1002",
            ErrorCategory::User,
            "Unknown Schema Version",
            format!(
                "Project schema version {} is not recognized. This version of the application supports up to version {}.",
                from_version, CURRENT_SCHEMA_VERSION
            ),
        ));
    }

    // Future: add per-version migration logic here
    // e.g.:
    // let mut v = data;
    // if from_version <= 1 && to_version >= 2 { v = migrate_v1_to_v2(v)?; }
    // if from_version <= 2 && to_version >= 3 { v = migrate_v2_to_v3(v)?; }

    Err(AppError::new(
        "E-1004",
        ErrorCategory::Internal,
        "Migration Not Implemented",
        format!(
            "Migration from version {} to {} is not yet implemented.",
            from_version, to_version
        ),
    ))
}

/// Returns the schema version stored in a project JSON value.
pub fn detect_schema_version(data: &serde_json::Value) -> u32 {
    data.get("schema_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_version_from_value() {
        let json = serde_json::json!({ "schema_version": 1 });
        assert_eq!(detect_schema_version(&json), 1);
    }

    #[test]
    fn test_detect_version_missing() {
        let json = serde_json::json!({});
        assert_eq!(detect_schema_version(&json), 0);
    }

    #[test]
    fn test_migration_same_version() {
        let data = serde_json::json!({ "name": "test" });
        let result = migrate(data.clone(), 1, 1).unwrap();
        assert_eq!(result, data);
    }

    #[test]
    fn test_migration_downgrade_error() {
        let data = serde_json::json!({});
        let result = migrate(data, 2, 1);
        assert!(result.is_err());
    }

    #[test]
    fn test_migration_unknown_version() {
        let data = serde_json::json!({});
        let result = migrate(data, 99, 100);
        assert!(result.is_err());
    }
}
