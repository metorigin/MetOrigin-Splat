//! Project management for MetOrigin Splat.
//!
//! Handles creation, opening, saving, validation, and migration of
//! `.splat-project` directories.

pub mod migration;
pub mod paths;
pub mod project_manager;

pub use project_manager::ProjectManager;
