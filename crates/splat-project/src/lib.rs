//! Project management for MetOrigin Splat.
//!
//! Handles creation, opening, saving, validation, and migration of
//! project directories containing `project.json`, including legacy
//! `.splat-project` folders.

pub mod execution_profile;
pub mod migration;
pub mod paths;
pub mod project_manager;

pub use execution_profile::{
    execution_profile_path, load_execution_profile, save_execution_profile,
};
pub use project_manager::ProjectManager;
