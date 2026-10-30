use super::*;
use crate::ExportManager;

const ASCII: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
));

fn check(bytes: &[u8]) -> AppResult<PlyHeaderMetadata> {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("model.ply");
    std::fs::write(&path, bytes).unwrap();
    ExportManager::inspect_ply(&path)
}

fn binary(degree: u8, big_endian: bool, doubles: bool, normals: bool) -> Vec<u8> {
    let (original_header, original_data) = ASCII.split_once("end_header\n").unwrap();
    let format = if big_endian {
        "binary_big_endian"
    } else {
        "binary_little_endian"
    };
    let mut header = original_header
        .replace("format ascii", &format!("format {format}"))
        .replace("SH degree: 0", &format!("SH degree: {degree}"));
    let mut values: Vec<f64> = original_data
        .split_whitespace()
        .map(|value| value.parse().unwrap())
        .collect();
    // The published Gaussian convention has RGB * ((degree + 1)^2 - 1)
    // channel-major non-DC coefficients. Test data is independent of the reader.
    for index in 0..3 * ((u32::from(degree) + 1).pow(2) - 1) {
        header.push_str(&format!("property float f_rest_{index}\n"));
        values.push(f64::from(index) * 0.001);
    }
    if normals {
        for name in ["nx", "ny", "nz"] {
            header.push_str(&format!("property float {name}\n"));
            values.push(0.0);
        }
    }
    if doubles {
        header = header.replace("property float ", "property double ");
    }
    let mut bytes = (header + "end_header\n").into_bytes();
    for value in values {
        if doubles {
            bytes.extend(if big_endian {
                value.to_be_bytes()
            } else {
                value.to_le_bytes()
            });
        } else {
            bytes.extend(if big_endian {
                (value as f32).to_be_bytes()
            } else {
                (value as f32).to_le_bytes()
            });
        }
    }
    bytes
}

#[test]
fn accepts_complete_ascii_and_crlf_gaussians() {
    assert_eq!(
        check(ASCII.as_bytes()).unwrap(),
        PlyHeaderMetadata {
            vertex_count: 1,
            sh_degree: 0,
        }
    );
    assert!(check(ASCII.replace('\n', "\r\n").as_bytes()).is_ok());
    assert!(check((ASCII.to_owned() + "\n  \t\n").as_bytes()).is_ok());
}

#[test]
fn accepts_legacy_binary_normals_and_brush_sh_degrees() {
    for degree in 0..=3 {
        for big_endian in [false, true] {
            for doubles in [false, true] {
                let metadata = check(&binary(degree, big_endian, doubles, true)).unwrap();
                assert_eq!(metadata.vertex_count, 1);
                assert_eq!(metadata.sh_degree, degree);
            }
        }
    }
}

#[test]
fn accepts_empty_face_element_without_treating_its_list_as_vertex_data() {
    let text = ASCII.replace(
        "end_header\n",
        "element face 0\nproperty list uchar int vertex_indices\nend_header\n",
    );
    assert!(check(text.as_bytes()).is_ok());
    assert!(check(text.replace("element face 0", "element face 1").as_bytes()).is_err());
}

#[test]
fn rejects_old_header_only_test_data_and_missing_gaussian_properties() {
    for bytes in [
        b"ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0\n".as_slice(),
        ASCII.replace("property float opacity\n", "").as_bytes(),
        ASCII
            .replace("property float opacity", "property int opacity")
            .as_bytes(),
    ] {
        let error = check(bytes).unwrap_err();
        assert_eq!(error.code, "E-4006");
        assert_eq!(error.category, ErrorCategory::Engine);
    }
}

#[test]
fn rejects_incomplete_header_duplicate_properties_and_bad_magic() {
    for text in [
        ASCII.replace("end_header\n", ""),
        ASCII.replace("property float x\n", "property float x\nproperty float x\n"),
        ASCII.replacen("ply\n", "ply-invalid\n", 1),
        ASCII.replace("format ascii 1.0", "format ascii 2.0"),
        ASCII.replace("element vertex 1", "element vertex 0"),
    ] {
        assert!(check(text.as_bytes()).is_err());
    }
}

#[test]
fn rejects_binary_truncation_extra_bytes_and_count_overflow() {
    let original = binary(3, false, false, true);
    for size in [original.len() - 1, original.len() - 4, 0] {
        assert!(check(&original[..size]).is_err());
    }
    let mut extra = original;
    extra.push(0);
    assert!(check(&extra).is_err());
    let text = ASCII
        .replace("format ascii", "format binary_little_endian")
        .replace("element vertex 1", "element vertex 18446744073709551615");
    assert!(check(text.as_bytes()).is_err());
}

#[test]
fn rejects_infinite_nan_and_float32_overflow_in_ascii() {
    for value in ["NaN", "inf", "-inf", "1e100", "not-a-number"] {
        assert!(check(
            ASCII
                .replace("0.25 -0.5", &format!("{value} -0.5"))
                .as_bytes()
        )
        .is_err());
    }
    let (_, data) = ASCII.split_once("end_header\n").unwrap();
    assert!(check(ASCII.replace(data, "0 0 0\n").as_bytes()).is_err());
    assert!(check((ASCII.to_owned() + data).as_bytes()).is_err());
}

#[test]
fn rejects_nonfinite_binary_values_including_optional_fields() {
    for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut bytes = binary(0, false, false, true);
        let offset = bytes.len() - 4;
        bytes[offset..].copy_from_slice(&value.to_le_bytes());
        assert!(check(&bytes).is_err());
    }
    let mut bytes = binary(0, true, true, false);
    let offset = bytes.len() - 8;
    bytes[offset..].copy_from_slice(&f64::NAN.to_be_bytes());
    assert!(check(&bytes).is_err());
}

#[test]
fn rejects_inconsistent_and_noncontiguous_spherical_harmonics() {
    assert!(check(&binary(4, false, false, false)).is_err());
    assert!(check(ASCII.replace("SH degree: 0", "SH degree: 1").as_bytes()).is_err());
    let mut header = ASCII.split_once("end_header\n").unwrap().0.to_owned();
    for index in 1..=9 {
        header.push_str(&format!("property float f_rest_{index}\n"));
    }
    header.push_str("end_header\n");
    assert!(check(header.as_bytes()).is_err());
    assert!(check(
        ASCII
            .replace("end_header", "property float f_rest_0\nend_header")
            .as_bytes()
    )
    .is_err());
    assert!(check(
        ASCII
            .replace("end_header", "property float f_rest_bad\nend_header")
            .as_bytes()
    )
    .is_err());
}

#[test]
fn bounded_header_and_row_cannot_consume_unbounded_memory() {
    let header = "ply\ncomment ".to_owned() + &"x".repeat(MAX_HEADER_BYTES + 1);
    assert!(check(header.as_bytes()).is_err());
    let (header, _) = ASCII.split_once("end_header\n").unwrap();
    let body = header.to_owned() + "end_header\n" + &"0 ".repeat(MAX_LINE_BYTES);
    assert!(check(body.as_bytes()).is_err());
}

#[test]
fn count_validates_payload_while_explicit_header_only_api_does_not() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("partial.ply");
    let header = ASCII.split_once("end_header\n").unwrap().0.to_owned() + "end_header\n";
    std::fs::write(&path, header).unwrap();
    assert_eq!(
        ExportManager::read_header_metadata(&path)
            .unwrap()
            .vertex_count,
        1
    );
    assert!(ExportManager::vertex_count(&path).is_err());
    assert!(ExportManager::validate_ply(&path).is_err());
}

#[test]
fn missing_file_is_a_filesystem_failure_not_a_valid_empty_model() {
    let directory = tempfile::tempdir().unwrap();
    let error = ExportManager::validate_ply(&directory.path().join("missing.ply")).unwrap_err();
    assert_eq!(error.code, "E-1201");
    assert_eq!(error.category, ErrorCategory::Filesystem);
}

#[cfg(unix)]
#[test]
fn unreadable_file_reports_a_filesystem_failure() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private.ply");
    std::fs::write(&path, ASCII).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Elevated test runners can bypass mode bits. Ordinary-user runs exercise
    // the actual open failure; the typed mapping is also tested below.
    if File::open(&path).is_err() {
        let error = ExportManager::validate_ply(&path).unwrap_err();
        assert_eq!(error.code, "E-1201");
        assert_eq!(error.category, ErrorCategory::Filesystem);
    }
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        io_error(std::io::Error::from(std::io::ErrorKind::PermissionDenied)).category,
        ErrorCategory::Filesystem
    );
}

#[test]
#[ignore = "Requires a local real-engine Gaussian PLY in SPLAT_REAL_BRUSH_PLY"]
fn validates_real_brush_export() {
    let path = std::env::var_os("SPLAT_REAL_BRUSH_PLY")
        .map(std::path::PathBuf::from)
        .expect("Set SPLAT_REAL_BRUSH_PLY to an independently produced Brush PLY");
    let metadata = ExportManager::inspect_ply(&path).unwrap();
    assert!(metadata.vertex_count > 0);
}

#[test]
fn native_preview_borrows_bytes_and_rejects_unsupported_layouts_and_nan() {
    for degree in 0..=3 {
        let bytes = binary(degree, false, false, true);
        assert_eq!(
            ExportManager::inspect_preview_bytes(&bytes)
                .unwrap()
                .sh_degree,
            degree
        );
    }
    for bytes in [
        binary(0, true, false, false),
        binary(0, false, true, false),
        ASCII.as_bytes().to_vec(),
    ] {
        assert!(ExportManager::inspect_preview_bytes(&bytes).is_err());
    }
    let mut bytes = binary(0, false, false, false);
    let offset = bytes.len() - 4;
    bytes[offset..].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(ExportManager::inspect_preview_bytes(&bytes).is_err());
}

#[test]
fn preview_header_is_only_metadata_and_same_open_file_survives_path_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("model.ply");
    let original = binary(0, false, false, false);
    std::fs::write(&path, &original).unwrap();
    let mut opened = File::open(&path).unwrap();
    let replacement = dir.path().join("replacement.ply");
    std::fs::write(&replacement, b"invalid").unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    assert_eq!(
        ExportManager::read_preview_header(&mut opened)
            .unwrap()
            .vertex_count,
        1
    );
    assert!(ExportManager::inspect_open_ply(&mut opened).is_ok());
    assert!(ExportManager::inspect_ply(&path).is_err());
    let mut invalid_value = original;
    let offset = invalid_value.len() - 4;
    invalid_value[offset..].copy_from_slice(&f32::INFINITY.to_le_bytes());
    std::fs::write(&path, &invalid_value).unwrap();
    assert!(ExportManager::read_preview_header(&mut File::open(&path).unwrap()).is_ok());
    assert!(ExportManager::inspect_preview_bytes(&invalid_value).is_err());
}
