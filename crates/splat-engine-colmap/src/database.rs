use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::CommandSpec;

use crate::runtime;

/// Counts read directly from a COLMAP SQLite database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DatabaseStats {
    pub cameras: usize,
    pub images: usize,
    pub keypoints: usize,
    pub matched_pairs: usize,
    pub verified_matches: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CameraConsolidationResult {
    pub images: usize,
    pub cameras_before: usize,
    pub cameras_after: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct MatchGraphStats {
    pub total_images: usize,
    pub verified_edges: usize,
    pub largest_component_images: usize,
    pub largest_component_coverage: f64,
}

pub fn inspect_match_graph(database_path: &Path) -> AppResult<MatchGraphStats> {
    const MAX_IMAGE_ID: i64 = 2_147_483_647;
    let connection = rusqlite::Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| database_error(database_path, error))?;
    let mut image_statement = connection
        .prepare("SELECT image_id FROM images ORDER BY image_id")
        .map_err(|error| database_error(database_path, error))?;
    let image_ids = image_statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| database_error(database_path, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(database_path, error))?;
    drop(image_statement);
    let positions = image_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect::<BTreeMap<_, _>>();
    let mut parents = (0..image_ids.len()).collect::<Vec<_>>();
    let mut sizes = vec![1_usize; image_ids.len()];
    let mut edge_statement = connection
        .prepare("SELECT pair_id FROM two_view_geometries WHERE rows > 0")
        .map_err(|error| database_error(database_path, error))?;
    let pair_ids = edge_statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| database_error(database_path, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(database_path, error))?;
    let verified_edges = pair_ids.len();
    for pair_id in pair_ids {
        let second = pair_id % MAX_IMAGE_ID;
        let first = (pair_id - second) / MAX_IMAGE_ID;
        if let (Some(&left), Some(&right)) = (positions.get(&first), positions.get(&second)) {
            union_components(&mut parents, &mut sizes, left, right);
        }
    }
    let largest_component_images = if image_ids.is_empty() {
        0
    } else {
        (0..image_ids.len())
            .map(|index| {
                let root = find_component(&mut parents, index);
                sizes[root]
            })
            .max()
            .unwrap_or(0)
    };
    Ok(MatchGraphStats {
        total_images: image_ids.len(),
        verified_edges,
        largest_component_images,
        largest_component_coverage: if image_ids.is_empty() {
            0.0
        } else {
            largest_component_images as f64 / image_ids.len() as f64
        },
    })
}

fn find_component(parents: &mut [usize], index: usize) -> usize {
    if parents[index] != index {
        parents[index] = find_component(parents, parents[index]);
    }
    parents[index]
}

fn union_components(parents: &mut [usize], sizes: &mut [usize], left: usize, right: usize) {
    let mut left_root = find_component(parents, left);
    let mut right_root = find_component(parents, right);
    if left_root == right_root {
        return;
    }
    if sizes[left_root] < sizes[right_root] {
        std::mem::swap(&mut left_root, &mut right_root);
    }
    parents[right_root] = left_root;
    sizes[left_root] += sizes[right_root];
}

/// Merge the per-image cameras created by COLMAP according to a trusted image
/// manifest. The whole operation is transactional: a missing image mapping or
/// incompatible camera model/dimensions leaves the database unchanged.
pub fn consolidate_camera_groups(
    database_path: &Path,
    image_to_group: &BTreeMap<String, String>,
) -> AppResult<CameraConsolidationResult> {
    let mut connection = rusqlite::Connection::open(database_path)
        .map_err(|error| database_error(database_path, error))?;
    let transaction = connection.transaction().map_err(|error| {
        AppError::new(
            "E-3011",
            ErrorCategory::Engine,
            "Failed to Start Camera Consolidation",
            "COLMAP camera groups could not be updated transactionally.",
        )
        .with_technical(error.to_string())
    })?;

    #[derive(Clone)]
    struct CameraRow {
        id: i64,
        model: i64,
        width: i64,
        height: i64,
    }

    #[derive(Clone)]
    struct ImageCameraRow {
        name: String,
        image_id: i64,
        camera: CameraRow,
    }

    let cameras_before = query_count(&transaction, "SELECT COUNT(*) FROM cameras")?;
    let mut statement = transaction
        .prepare(
            "SELECT images.name, images.image_id, cameras.camera_id, cameras.model, cameras.width, cameras.height \
             FROM images JOIN cameras ON cameras.camera_id = images.camera_id ORDER BY images.name",
        )
        .map_err(|error| database_error(database_path, error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ImageCameraRow {
                name: row.get(0)?,
                image_id: row.get(1)?,
                camera: CameraRow {
                    id: row.get(2)?,
                    model: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                },
            })
        })
        .map_err(|error| database_error(database_path, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| database_error(database_path, error))?;
    drop(statement);

    if rows.is_empty() {
        return Err(AppError::new(
            "E-3011",
            ErrorCategory::Engine,
            "No COLMAP Cameras to Consolidate",
            "The feature database does not contain images and cameras.",
        ));
    }

    let has_rig_schema = ["rigs", "rig_sensors", "frames", "frame_data"]
        .iter()
        .try_fold(true, |present, table| {
            table_exists(&transaction, table).map(|exists| present && exists)
        })?;
    let mut grouped = BTreeMap::<String, Vec<ImageCameraRow>>::new();
    for image in rows {
        let group = image_to_group.get(&image.name).ok_or_else(|| {
            AppError::new(
                "E-3011",
                ErrorCategory::Engine,
                "Camera Manifest Mismatch",
                format!(
                    "The image '{}' has no camera group in frames.json.",
                    image.name
                ),
            )
        })?;
        grouped.entry(group.clone()).or_default().push(image);
    }

    let mut referenced_cameras = BTreeSet::new();
    let mut obsolete_rigs = BTreeSet::new();
    for (group, members) in grouped {
        let canonical = members
            .iter()
            .map(|image| &image.camera)
            .min_by_key(|camera| camera.id)
            .expect("camera group is non-empty")
            .clone();
        if members.iter().any(|image| {
            image.camera.model != canonical.model
                || image.camera.width != canonical.width
                || image.camera.height != canonical.height
        }) {
            return Err(AppError::new(
                "E-3011",
                ErrorCategory::Engine,
                "Incompatible Camera Group",
                format!("Camera group '{group}' contains different models or image dimensions."),
            ));
        }
        referenced_cameras.insert(canonical.id);
        let frame_rigs = if has_rig_schema {
            members
                .iter()
                .map(|image| {
                    transaction
                        .query_row(
                            "SELECT frames.frame_id, frames.rig_id \
                             FROM frame_data JOIN frames ON frames.frame_id = frame_data.frame_id \
                             WHERE frame_data.data_id = ?1 AND frame_data.sensor_type = 0",
                            [image.image_id],
                            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                        )
                        .map(|frame_rig| (image.image_id, image.camera.id, frame_rig))
                        .map_err(|error| database_error(database_path, error))
                })
                .collect::<AppResult<Vec<_>>>()?
        } else {
            Vec::new()
        };
        if has_rig_schema {
            let canonical_rig = frame_rigs
                .iter()
                .find(|(_, camera_id, _)| *camera_id == canonical.id)
                .map(|(_, _, (_, rig_id))| *rig_id)
                .ok_or_else(|| {
                    AppError::new(
                        "E-3011",
                        ErrorCategory::Engine,
                        "Camera Rig Consolidation Failed",
                        format!("Camera group '{group}' has no canonical COLMAP rig."),
                    )
                })?;
            let canonical_sensor: i64 = transaction
                .query_row(
                    "SELECT ref_sensor_id FROM rigs WHERE rig_id = ?1 AND ref_sensor_type = 0",
                    [canonical_rig],
                    |row| row.get(0),
                )
                .map_err(|error| database_error(database_path, error))?;
            if canonical_sensor != canonical.id {
                return Err(AppError::new(
                    "E-3011",
                    ErrorCategory::Engine,
                    "Camera Rig Consolidation Failed",
                    format!("Camera group '{group}' has an inconsistent canonical rig."),
                ));
            }
            for (image_id, _, (frame_id, rig_id)) in &frame_rigs {
                transaction
                    .execute(
                        "UPDATE frames SET rig_id = ?1 WHERE frame_id = ?2",
                        rusqlite::params![canonical_rig, frame_id],
                    )
                    .map_err(|error| database_error(database_path, error))?;
                transaction
                    .execute(
                        "UPDATE frame_data SET sensor_id = ?1 \
                         WHERE frame_id = ?2 AND data_id = ?3 AND sensor_type = 0",
                        rusqlite::params![canonical.id, frame_id, image_id],
                    )
                    .map_err(|error| database_error(database_path, error))?;
                if *rig_id != canonical_rig {
                    obsolete_rigs.insert(*rig_id);
                }
            }
        }
        for image in members {
            transaction
                .execute(
                    "UPDATE images SET camera_id = ?1 WHERE name = ?2",
                    rusqlite::params![canonical.id, image.name],
                )
                .map_err(|error| database_error(database_path, error))?;
        }
    }
    for rig_id in obsolete_rigs {
        transaction
            .execute("DELETE FROM rig_sensors WHERE rig_id = ?1", [rig_id])
            .map_err(|error| database_error(database_path, error))?;
        transaction
            .execute("DELETE FROM rigs WHERE rig_id = ?1", [rig_id])
            .map_err(|error| database_error(database_path, error))?;
    }
    transaction
        .execute(
            "DELETE FROM cameras WHERE camera_id NOT IN (SELECT DISTINCT camera_id FROM images)",
            [],
        )
        .map_err(|error| database_error(database_path, error))?;
    let cameras_after = query_count(&transaction, "SELECT COUNT(*) FROM cameras")?;
    let images = query_count(&transaction, "SELECT COUNT(*) FROM images")?;
    if cameras_after != referenced_cameras.len() {
        return Err(AppError::new(
            "E-3011",
            ErrorCategory::Engine,
            "Camera Consolidation Verification Failed",
            "The number of cameras after consolidation does not match the manifest groups.",
        ));
    }
    if has_rig_schema {
        let invalid_rig_references = query_count(
            &transaction,
            "SELECT COUNT(*) FROM rigs LEFT JOIN cameras \
             ON cameras.camera_id = rigs.ref_sensor_id \
             WHERE rigs.ref_sensor_type = 0 AND cameras.camera_id IS NULL",
        )?;
        let invalid_frame_references = query_count(
            &transaction,
            "SELECT COUNT(*) FROM frame_data LEFT JOIN cameras \
             ON cameras.camera_id = frame_data.sensor_id \
             WHERE frame_data.sensor_type = 0 AND cameras.camera_id IS NULL",
        )?;
        if invalid_rig_references > 0 || invalid_frame_references > 0 {
            return Err(AppError::new(
                "E-3011",
                ErrorCategory::Engine,
                "Camera Rig Consolidation Verification Failed",
                "COLMAP rig or frame metadata still references a removed camera.",
            ));
        }
    }
    transaction.commit().map_err(|error| {
        AppError::new(
            "E-3011",
            ErrorCategory::Engine,
            "Failed to Commit Camera Consolidation",
            "COLMAP camera groups were rolled back.",
        )
        .with_technical(error.to_string())
    })?;
    Ok(CameraConsolidationResult {
        images,
        cameras_before,
        cameras_after,
    })
}

/// Inspect a COLMAP database without relying on version-specific CLI commands.
pub fn inspect_database(database_path: &Path) -> AppResult<DatabaseStats> {
    let connection = rusqlite::Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| database_error(database_path, error))?;

    Ok(DatabaseStats {
        cameras: query_count(&connection, "SELECT COUNT(*) FROM cameras")?,
        images: query_count(&connection, "SELECT COUNT(*) FROM images")?,
        keypoints: query_count(&connection, "SELECT COALESCE(SUM(rows), 0) FROM keypoints")?,
        matched_pairs: query_count(
            &connection,
            "SELECT COUNT(*) FROM two_view_geometries WHERE rows > 0",
        )?,
        verified_matches: query_count(
            &connection,
            "SELECT COALESCE(SUM(rows), 0) FROM two_view_geometries",
        )?,
    })
}

/// Return the image names registered in a COLMAP database.
pub fn inspect_database_image_names(database_path: &Path) -> AppResult<Vec<String>> {
    let connection = rusqlite::Connection::open_with_flags(
        database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| database_error(database_path, error))?;
    let mut statement = connection
        .prepare("SELECT name FROM images ORDER BY name")
        .map_err(|error| {
            AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "Failed to Inspect COLMAP Images",
                "无法读取 COLMAP 数据库中的图片列表。",
            )
            .with_technical(error.to_string())
        })?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| {
            AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "Failed to Inspect COLMAP Images",
                "无法查询 COLMAP 数据库中的图片列表。",
            )
            .with_technical(error.to_string())
        })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        AppError::new(
            "E-3002",
            ErrorCategory::Engine,
            "Failed to Read COLMAP Image Names",
            "COLMAP 数据库包含无法读取的图片名称。",
        )
        .with_technical(error.to_string())
    })
}

fn query_count(connection: &rusqlite::Connection, sql: &str) -> AppResult<usize> {
    connection
        .query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|value| value.max(0) as usize)
        .map_err(|error| {
            AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "Failed to Inspect COLMAP Database",
                "The COLMAP database schema could not be queried.",
            )
            .with_technical(format!("query={sql}, error={error}"))
        })
}

fn table_exists(connection: &rusqlite::Connection, table: &str) -> AppResult<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| {
            AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "Failed to Inspect COLMAP Database",
                "The COLMAP database schema could not be queried.",
            )
            .with_technical(format!("table={table}, error={error}"))
        })
}

fn database_error(path: &Path, error: rusqlite::Error) -> AppError {
    AppError::new(
        "E-3002",
        ErrorCategory::Engine,
        "Failed to Open COLMAP Database",
        "The COLMAP database could not be opened for validation.",
    )
    .with_technical(format!("path={}, error={error}", path.display()))
}

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
        runtime::command_spec(
            &self.colmap_path,
            vec![
                "database_creator",
                "--log_target",
                "stderr",
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
    fn test_inspect_database_reads_standard_colmap_schema() {
        let dir = std::env::temp_dir().join(format!("splat-colmap-inspect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("database.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cameras (camera_id INTEGER PRIMARY KEY);\
                 CREATE TABLE images (image_id INTEGER PRIMARY KEY);\
                 CREATE TABLE keypoints (image_id INTEGER PRIMARY KEY, rows INTEGER);\
                 CREATE TABLE two_view_geometries (pair_id INTEGER PRIMARY KEY, rows INTEGER);\
                 INSERT INTO cameras VALUES (1), (2);\
                 INSERT INTO images VALUES (1), (2), (3);\
                 INSERT INTO keypoints VALUES (1, 100), (2, 250), (3, 0);\
                 INSERT INTO two_view_geometries VALUES (1, 42), (2, 0), (3, 17);",
            )
            .unwrap();
        drop(connection);

        let stats = inspect_database(&db_path).unwrap();
        assert_eq!(
            stats,
            DatabaseStats {
                cameras: 2,
                images: 3,
                keypoints: 350,
                matched_pairs: 2,
                verified_matches: 59,
            }
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn consolidates_per_image_cameras_and_rolls_back_on_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("database.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE cameras (camera_id INTEGER PRIMARY KEY, model INTEGER, width INTEGER, height INTEGER);\
                 CREATE TABLE images (image_id INTEGER PRIMARY KEY, name TEXT UNIQUE, camera_id INTEGER);\
                 INSERT INTO cameras VALUES (1, 2, 2560, 1707), (2, 2, 2560, 1707), (3, 2, 1707, 2560);\
                 INSERT INTO images VALUES (1, '000001.jpg', 1), (2, '000002.jpg', 2), (3, '000003.jpg', 3);",
            )
            .unwrap();
        drop(connection);
        let groups = BTreeMap::from([
            ("000001.jpg".into(), "landscape".into()),
            ("000002.jpg".into(), "landscape".into()),
            ("000003.jpg".into(), "portrait".into()),
        ]);
        let result = consolidate_camera_groups(&db_path, &groups).unwrap();
        assert_eq!(result.cameras_before, 3);
        assert_eq!(result.cameras_after, 2);

        let bad = BTreeMap::from([
            ("000001.jpg".into(), "all".into()),
            ("000002.jpg".into(), "all".into()),
            ("000003.jpg".into(), "all".into()),
        ]);
        assert!(consolidate_camera_groups(&db_path, &bad).is_err());
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        let camera_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM cameras", [], |row| row.get(0))
            .unwrap();
        assert_eq!(camera_count, 2);
    }

    #[test]
    fn consolidates_colmap_4_rigs_frames_and_camera_sensors() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("database.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;\
                 CREATE TABLE cameras (camera_id INTEGER PRIMARY KEY, model INTEGER, width INTEGER, height INTEGER);\
                 CREATE TABLE images (image_id INTEGER PRIMARY KEY, name TEXT UNIQUE, camera_id INTEGER);\
                 CREATE TABLE rigs (rig_id INTEGER PRIMARY KEY, ref_sensor_id INTEGER NOT NULL, ref_sensor_type INTEGER NOT NULL);\
                 CREATE UNIQUE INDEX rig_ref_sensor_assignment ON rigs(ref_sensor_id, ref_sensor_type);\
                 CREATE TABLE rig_sensors (rig_id INTEGER NOT NULL, sensor_id INTEGER NOT NULL, sensor_type INTEGER NOT NULL, sensor_from_rig BLOB);\
                 CREATE UNIQUE INDEX rig_sensor_assignment ON rig_sensors(sensor_id, sensor_type);\
                 CREATE TABLE frames (frame_id INTEGER PRIMARY KEY, rig_id INTEGER NOT NULL, FOREIGN KEY(rig_id) REFERENCES rigs(rig_id) ON DELETE CASCADE);\
                 CREATE TABLE frame_data (frame_id INTEGER NOT NULL, data_id INTEGER NOT NULL, sensor_id INTEGER NOT NULL, sensor_type INTEGER NOT NULL, FOREIGN KEY(frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE);\
                 CREATE UNIQUE INDEX frame_sensor_assignment ON frame_data(data_id, sensor_type);\
                 INSERT INTO cameras VALUES (1, 2, 2560, 1707), (2, 2, 2560, 1707), (3, 2, 1707, 2560);\
                 INSERT INTO images VALUES (1, '000001.jpg', 1), (2, '000002.jpg', 2), (3, '000003.jpg', 3);\
                 INSERT INTO rigs VALUES (1, 1, 0), (2, 2, 0), (3, 3, 0);\
                 INSERT INTO rig_sensors VALUES (1, 1, 0, NULL), (2, 2, 0, NULL), (3, 3, 0, NULL);\
                 INSERT INTO frames VALUES (1, 1), (2, 2), (3, 3);\
                 INSERT INTO frame_data VALUES (1, 1, 1, 0), (2, 2, 2, 0), (3, 3, 3, 0);",
            )
            .unwrap();
        drop(connection);
        let groups = BTreeMap::from([
            ("000001.jpg".into(), "landscape".into()),
            ("000002.jpg".into(), "landscape".into()),
            ("000003.jpg".into(), "portrait".into()),
        ]);

        let result = consolidate_camera_groups(&db_path, &groups).unwrap();
        assert_eq!(result.cameras_after, 2);
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        let rigs: Vec<(i64, i64)> = {
            let mut statement = connection
                .prepare("SELECT rig_id, ref_sensor_id FROM rigs ORDER BY rig_id")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(rigs, vec![(1, 1), (3, 3)]);
        let frames: Vec<(i64, i64, i64)> = {
            let mut statement = connection
                .prepare(
                    "SELECT frames.frame_id, frames.rig_id, frame_data.sensor_id \
                     FROM frames JOIN frame_data USING(frame_id) ORDER BY frames.frame_id",
                )
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(frames, vec![(1, 1, 1), (2, 1, 1), (3, 3, 3)]);
    }

    #[test]
    fn inspects_largest_verified_match_component() {
        const MAX: i64 = 2_147_483_647;
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("database.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE images (image_id INTEGER PRIMARY KEY);\
                 CREATE TABLE two_view_geometries (pair_id INTEGER PRIMARY KEY, rows INTEGER);\
                 INSERT INTO images VALUES (1), (2), (3), (4);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO two_view_geometries VALUES (?1, 20)",
                [1 * MAX + 2],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO two_view_geometries VALUES (?1, 15)",
                [2 * MAX + 3],
            )
            .unwrap();
        drop(connection);
        let graph = inspect_match_graph(&db_path).unwrap();
        assert_eq!(graph.verified_edges, 2);
        assert_eq!(graph.largest_component_images, 3);
        assert!((graph.largest_component_coverage - 0.75).abs() < 1e-9);
    }

    #[test]
    fn test_inspect_database_image_names_reports_registered_files() {
        let dir =
            std::env::temp_dir().join(format!("splat-colmap-image-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("database.db");
        let connection = rusqlite::Connection::open(&db_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE images (image_id INTEGER PRIMARY KEY, name TEXT);\
                 INSERT INTO images VALUES (1, '000001.jpg'), (2, '000003.jpg');",
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            inspect_database_image_names(&db_path).unwrap(),
            vec!["000001.jpg", "000003.jpg"]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

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
