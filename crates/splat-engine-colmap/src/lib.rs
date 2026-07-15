//! COLMAP engine adapter for MetOrigin Splat.
//!
//! Handles COLMAP pipeline stages: database initialization,
//! feature extraction, feature matching, sparse mapping,
//! and model validation. All COLMAP interactions go through
//! this adapter — never directly in business logic.

pub mod adapter;
pub mod database;
pub mod diagnostics;
pub mod feature;
pub mod mapper;
pub mod matching;
pub mod progress;
pub mod result;
pub mod types;
pub mod validator;

pub use adapter::ColmapAdapter;
pub use database::{
    consolidate_camera_groups, inspect_database, inspect_database_image_names, inspect_match_graph,
    CameraConsolidationResult, DatabaseCreator, DatabaseStats, MatchGraphStats,
};
pub use diagnostics::{ColmapDiagnosticReport, DiagnosticItem};
pub use feature::{FeatureExtractionOptions, FeatureExtractor};
pub use mapper::{read_registered_image_names, validate_model_image_dimensions, ColmapMapper};
pub use matching::MatchingValidator;
pub use progress::{ColmapFeatureParser, ColmapMapperParser};
pub use result::{
    read_colmap_result, write_colmap_result_atomic, ColmapAttemptResult, ColmapAttemptStatus,
    ColmapResult,
};
pub use types::{
    CameraInfo, CameraModel, DiagnosticLevel, DiagnosticMessage, FeatureExtractionResult,
    MapperKind, MatchingOptions, MatchingResult, MatchingStrategy, ModelInfo,
};
pub use validator::{
    ColmapValidator, QualityDecision, RegistrationSegment, ValidationCheck, ValidationContext,
    ValidationOptions, ValidationReport,
};
