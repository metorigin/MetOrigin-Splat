//! Bounded, streaming validation of the Gaussian PLY formats emitted by Brush.
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use splat_domain::error::{AppError, AppResult, ErrorCategory};

const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_PROPERTIES: usize = 256;
const REQUIRED: [&str; 14] = [
    "x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
    "f_dc_0", "f_dc_1", "f_dc_2",
];

/// Metadata declared by a structurally valid Gaussian header.
///
/// Reading this metadata alone does **not** validate the vertex payload. Use
/// `ExportManager::inspect_ply` before treating a file as complete or resumable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlyHeaderMetadata {
    pub vertex_count: u64,
    pub sh_degree: u8,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Encoding {
    Ascii,
    LittleEndian,
    BigEndian,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scalar {
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl Scalar {
    fn parse(name: &str) -> AppResult<Self> {
        match name {
            "char" | "int8" => Ok(Self::I8),
            "uchar" | "uint8" => Ok(Self::U8),
            "short" | "int16" => Ok(Self::I16),
            "ushort" | "uint16" => Ok(Self::U16),
            "int" | "int32" => Ok(Self::I32),
            "uint" | "uint32" => Ok(Self::U32),
            "float" | "float32" => Ok(Self::F32),
            "double" | "float64" => Ok(Self::F64),
            _ => Err(invalid("Unsupported PLY scalar type")),
        }
    }

    fn width(self) -> usize {
        match self {
            Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::F64 => 8,
        }
    }

    fn is_float(self) -> bool {
        matches!(self, Self::F32 | Self::F64)
    }

    fn valid_ascii(self, value: &str) -> bool {
        match self {
            Self::I8 => value.parse::<i8>().is_ok(),
            Self::U8 => value.parse::<u8>().is_ok(),
            Self::I16 => value.parse::<i16>().is_ok(),
            Self::U16 => value.parse::<u16>().is_ok(),
            Self::I32 => value.parse::<i32>().is_ok(),
            Self::U32 => value.parse::<u32>().is_ok(),
            Self::F32 => value.parse::<f32>().is_ok_and(f32::is_finite),
            Self::F64 => value.parse::<f64>().is_ok_and(f64::is_finite),
        }
    }

    fn finite_binary(self, bytes: &[u8], encoding: Encoding) -> bool {
        // Callers slice a complete record using the declared scalar width.
        match self {
            Self::F32 => {
                let bytes = [bytes[0], bytes[1], bytes[2], bytes[3]];
                let value = match encoding {
                    Encoding::BigEndian => f32::from_be_bytes(bytes),
                    _ => f32::from_le_bytes(bytes),
                };
                value.is_finite()
            }
            Self::F64 => {
                let bytes = [
                    bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                ];
                let value = match encoding {
                    Encoding::BigEndian => f64::from_be_bytes(bytes),
                    _ => f64::from_le_bytes(bytes),
                };
                value.is_finite()
            }
            _ => true,
        }
    }
}

struct Header {
    metadata: PlyHeaderMetadata,
    encoding: Encoding,
    properties: Vec<Scalar>,
    stride: usize,
    bytes: u64,
}

fn invalid(detail: &str) -> AppError {
    AppError::new(
        "E-4006",
        ErrorCategory::Engine,
        "Invalid Gaussian PLY",
        "The model is incomplete, damaged, or uses an unsupported Gaussian PLY format.",
    )
    .with_technical(detail)
    .with_suggestions(vec![
        "Wait for the current checkpoint to finish writing",
        "Use an earlier complete checkpoint or export the model again",
    ])
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Read PLY",
        "The model file could not be read. Check that it is available and readable.",
    )
    .with_technical(error.to_string())
}

fn line(reader: &mut impl BufRead, buffer: &mut Vec<u8>) -> AppResult<usize> {
    buffer.clear();
    let size = reader
        .take((MAX_LINE_BYTES + 1) as u64)
        .read_until(b'\n', buffer)
        .map_err(io_error)?;
    if size > MAX_LINE_BYTES {
        return Err(invalid("PLY line exceeds the bounded line size"));
    }
    Ok(size)
}

fn read_header(reader: &mut impl BufRead) -> AppResult<Header> {
    let mut buffer = Vec::new();
    let mut bytes = line(reader, &mut buffer)?;
    if buffer != b"ply\n" && buffer != b"ply\r\n" {
        return Err(invalid("Missing exact PLY magic line"));
    }
    let mut encoding = None;
    let mut vertex_count = None;
    let mut properties = Vec::new();
    let mut names = BTreeSet::new();
    let mut current_is_vertex = None;
    let mut empty_element_names = BTreeSet::new();
    let mut declared_sh = None;
    loop {
        let size = line(reader, &mut buffer)?;
        bytes += size;
        if size == 0 || bytes > MAX_HEADER_BYTES {
            return Err(invalid("Missing end_header or oversized PLY header"));
        }
        let text = std::str::from_utf8(&buffer)
            .map_err(|_| invalid("Non-text data encountered before end_header"))?;
        let words: Vec<_> = text.split_whitespace().collect();
        match words.as_slice() {
            ["comment", "SH", "degree:", value] => {
                let degree = value
                    .parse::<u8>()
                    .map_err(|_| invalid("Invalid SH degree comment"))?;
                if declared_sh.is_some_and(|previous| previous != degree) {
                    return Err(invalid("Conflicting SH degree comments"));
                }
                declared_sh = Some(degree);
            }
            ["comment" | "obj_info", ..] => {}
            ["format", format, "1.0"] if encoding.is_none() && vertex_count.is_none() => {
                encoding = Some(match *format {
                    "ascii" => Encoding::Ascii,
                    "binary_little_endian" => Encoding::LittleEndian,
                    "binary_big_endian" => Encoding::BigEndian,
                    _ => return Err(invalid("Unsupported PLY encoding")),
                });
            }
            ["element", name, count] if encoding.is_some() => {
                let count = count
                    .parse::<u64>()
                    .map_err(|_| invalid("Invalid PLY element count"))?;
                if *name == "vertex" {
                    if vertex_count.is_some() || count == 0 {
                        return Err(invalid(
                            "Duplicate vertex element or zero Gaussian vertices",
                        ));
                    }
                    vertex_count = Some(count);
                    current_is_vertex = Some(true);
                } else if count == 0 {
                    current_is_vertex = Some(false);
                    empty_element_names.clear();
                } else {
                    return Err(invalid("Non-empty non-vertex PLY elements are unsupported"));
                }
            }
            ["property", kind, name] if current_is_vertex.is_some() => {
                let scalar = Scalar::parse(kind)?;
                if current_is_vertex == Some(true) {
                    if properties.len() >= MAX_PROPERTIES || !names.insert((*name).to_owned()) {
                        return Err(invalid("Too many or duplicate Gaussian properties"));
                    }
                    properties.push(((*name).to_owned(), scalar));
                } else if !empty_element_names.insert((*name).to_owned()) {
                    return Err(invalid("Duplicate property in an empty PLY element"));
                }
            }
            ["property", "list", count_type, value_type, name]
                if current_is_vertex == Some(false) =>
            {
                if Scalar::parse(count_type)?.is_float()
                    || !empty_element_names.insert((*name).to_owned())
                {
                    return Err(invalid("Invalid list property in an empty PLY element"));
                }
                Scalar::parse(value_type)?;
            }
            ["end_header"] => break,
            _ => return Err(invalid("Unsupported or misplaced PLY header directive")),
        }
    }
    let encoding = encoding.ok_or_else(|| invalid("Missing PLY format declaration"))?;
    let vertex_count = vertex_count.ok_or_else(|| invalid("Missing Gaussian vertex element"))?;
    for required in REQUIRED {
        if !properties
            .iter()
            .any(|(name, scalar)| name == required && scalar.is_float())
        {
            return Err(invalid("Missing floating-point Gaussian property"));
        }
    }
    let mut rest = BTreeSet::new();
    for (name, scalar) in &properties {
        if let Some(index) = name.strip_prefix("f_rest_") {
            let index = index
                .parse::<usize>()
                .map_err(|_| invalid("Invalid spherical harmonic property name"))?;
            if name != &format!("f_rest_{index}") || !scalar.is_float() || !rest.insert(index) {
                return Err(invalid("Invalid spherical harmonic property"));
            }
        }
    }
    let sh_degree = match rest.len() {
        0 => 0,
        9 => 1,
        24 => 2,
        45 => 3,
        _ => return Err(invalid("Unsupported spherical harmonics coefficient count")),
    };
    if !rest.iter().copied().eq(0..rest.len())
        || declared_sh.is_some_and(|degree| degree != sh_degree)
    {
        return Err(invalid(
            "Non-contiguous SH properties or SH degree comment mismatch",
        ));
    }
    let properties: Vec<_> = properties.into_iter().map(|(_, scalar)| scalar).collect();
    let stride = properties.iter().map(|scalar| scalar.width()).sum();
    Ok(Header {
        metadata: PlyHeaderMetadata {
            vertex_count,
            sh_degree,
        },
        encoding,
        properties,
        stride,
        bytes: bytes as u64,
    })
}

fn validate_payload(reader: &mut impl BufRead, header: &Header, size: u64) -> AppResult<()> {
    match header.encoding {
        Encoding::Ascii => {
            let mut buffer = Vec::new();
            let mut vertices = 0;
            while vertices < header.metadata.vertex_count {
                if line(reader, &mut buffer)? == 0 {
                    return Err(invalid("Truncated ASCII Gaussian vertex payload"));
                }
                let text = std::str::from_utf8(&buffer)
                    .map_err(|_| invalid("Non-text ASCII Gaussian vertex payload"))?;
                let values: Vec<_> = text.split_whitespace().collect();
                if values.is_empty() {
                    continue;
                }
                if values.len() != header.properties.len()
                    || !values
                        .iter()
                        .zip(&header.properties)
                        .all(|(value, scalar)| scalar.valid_ascii(value))
                {
                    return Err(invalid(
                        "Invalid, non-finite, or incomplete ASCII Gaussian row",
                    ));
                }
                vertices += 1;
            }
        }
        encoding => {
            let expected_size = header
                .metadata
                .vertex_count
                .checked_mul(header.stride as u64)
                .and_then(|payload| payload.checked_add(header.bytes))
                .ok_or_else(|| invalid("Gaussian vertex payload size overflow"))?;
            if size != expected_size {
                return Err(invalid(
                    "Binary Gaussian payload size does not match its header",
                ));
            }
            let mut record = vec![0; header.stride];
            for _ in 0..header.metadata.vertex_count {
                reader.read_exact(&mut record).map_err(|error| {
                    if error.kind() == std::io::ErrorKind::UnexpectedEof {
                        invalid("Binary Gaussian payload was truncated during validation")
                    } else {
                        io_error(error)
                    }
                })?;
                let mut offset = 0;
                for scalar in &header.properties {
                    let end = offset + scalar.width();
                    if !scalar.finite_binary(&record[offset..end], encoding) {
                        return Err(invalid("Non-finite binary Gaussian property"));
                    }
                    offset = end;
                }
            }
        }
    }
    loop {
        let bytes = reader.fill_buf().map_err(io_error)?;
        if bytes.is_empty() {
            return Ok(());
        }
        if !matches!(header.encoding, Encoding::Ascii) || !bytes.iter().all(u8::is_ascii_whitespace)
        {
            return Err(invalid(
                "Unexpected data after the declared Gaussian vertices",
            ));
        }
        let count = bytes.len();
        reader.consume(count);
    }
}

pub(crate) fn metadata(path: &Path, validate: bool) -> AppResult<PlyHeaderMetadata> {
    let mut file = File::open(path).map_err(io_error)?;
    metadata_file(&mut file, validate)
}

pub(crate) fn metadata_file(file: &mut File, validate: bool) -> AppResult<PlyHeaderMetadata> {
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let before = file.metadata().map_err(io_error)?;
    if !before.is_file() {
        return Err(invalid("Gaussian PLY must be a regular file"));
    }
    // One reusable record and a bounded buffer, including multi-million splats.
    let mut reader = BufReader::with_capacity(128 * 1024, file);
    let header = read_header(&mut reader)?;
    if validate {
        validate_payload(&mut reader, &header, before.len())?;
        let after = reader.get_ref().metadata().map_err(io_error)?;
        if before.len() != after.len()
            || before
                .modified()
                .ok()
                .zip(after.modified().ok())
                .is_some_and(|(a, b)| a != b)
        {
            return Err(invalid("Gaussian PLY changed during validation"));
        }
    }
    Ok(header.metadata)
}

fn preview_layout(header: &Header, length: u64) -> AppResult<()> {
    if header.encoding != Encoding::LittleEndian
        || header
            .properties
            .iter()
            .any(|scalar| *scalar != Scalar::F32)
    {
        return Err(invalid(
            "Native preview requires binary little-endian float32 properties",
        ));
    }
    let expected = header
        .metadata
        .vertex_count
        .checked_mul(header.stride as u64)
        .and_then(|bytes| bytes.checked_add(header.bytes));
    if expected != Some(length) {
        return Err(invalid(
            "Preview payload length differs from its declared layout",
        ));
    }
    Ok(())
}

/// Header/layout only: safe metadata for a later, fully validated preview read.
pub(crate) fn preview_header(file: &mut File) -> AppResult<PlyHeaderMetadata> {
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(invalid("Gaussian PLY must be a regular file"));
    }
    let mut reader = BufReader::new(file);
    let header = read_header(&mut reader)?;
    preview_layout(&header, metadata.len())?;
    Ok(header.metadata)
}

/// Validate borrowed response bytes in place, without another model-sized copy.
pub(crate) fn preview_bytes(bytes: &[u8]) -> AppResult<PlyHeaderMetadata> {
    let mut reader = std::io::Cursor::new(bytes);
    let header = read_header(&mut reader)?;
    preview_layout(&header, bytes.len() as u64)?;
    validate_payload(&mut reader, &header, bytes.len() as u64)?;
    Ok(header.metadata)
}

#[cfg(test)]
mod tests;
