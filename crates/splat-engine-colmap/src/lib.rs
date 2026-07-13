//! COLMAP engine adapter for MetaOrigin Splat.
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
pub use database::DatabaseCreator;
pub use diagnostics::{ColmapDiagnosticReport, DiagnosticItem};
pub use feature::{FeatureExtractionOptions, FeatureExtractor};
pub use mapper::ColmapMapper;
pub use matching::MatchingValidator;
pub use progress::{ColmapFeatureParser, ColmapMapperParser};
pub use result::ColmapResult;
pub use types::{
    CameraInfo, CameraModel, DiagnosticLevel, DiagnosticMessage, FeatureExtractionResult,
    MatchingResult, MatchingStrategy, ModelInfo,
};
pub use validator::{ColmapValidator, ValidationCheck, ValidationOptions, ValidationReport};
