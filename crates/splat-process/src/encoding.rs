/// Decode raw bytes from a process stdout/stderr into a String.
///
/// Process output on Windows may be in the system code page (e.g. GBK for
/// Chinese systems) rather than UTF-8. This function tries UTF-8 first,
/// then falls back to lossy decoding.
///
/// # Arguments
///
/// * `bytes` — Raw bytes read from the process pipe
///
/// # Returns
///
/// A `String` that preserves as much of the original content as possible.
pub fn decode_process_output(bytes: &[u8]) -> String {
    // 1. Try UTF-8 first (covers most cases on modern systems)
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }

    // 2. On Windows, try the active code page encoding
    #[cfg(target_os = "windows")]
    {
        let codepage = get_windows_acp();
        if let Ok(decoded) = decode_codepage(bytes, codepage) {
            return decoded;
        }
    }

    // 3. Fallback: replace invalid byte sequences with U+FFFD
    String::from_utf8_lossy(bytes).to_string()
}

/// Decode bytes using the specified Windows code page.
fn decode_codepage(bytes: &[u8], codepage: u32) -> Result<String, ()> {
    let encoding = match codepage {
        936 => encoding_rs::GBK,
        950 => encoding_rs::BIG5,
        932 => encoding_rs::SHIFT_JIS,
        949 => encoding_rs::EUC_KR,
        65001 => encoding_rs::UTF_8,
        _ => return Err(()),
    };

    let (decoded, had_errors) = encoding.decode_without_bom_handling(bytes);
    if had_errors {
        Err(())
    } else {
        Ok(decoded.into_owned())
    }
}

/// Get the current Windows ANSI code page.
#[cfg(target_os = "windows")]
fn get_windows_acp() -> u32 {
    // Calling GetACP() from kernel32
    extern "system" {
        fn GetACP() -> u32;
    }
    unsafe { GetACP() }
}

/// Trim trailing newline/carriage return from a byte buffer.
pub fn trim_line_endings(bytes: &[u8]) -> &[u8] {
    let mut end = bytes.len();
    while end > 0 && matches!(bytes[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    &bytes[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_utf8() {
        let result = decode_process_output("hello 世界".as_bytes());
        assert_eq!(result, "hello 世界");
    }

    #[test]
    fn test_decode_ascii() {
        let result = decode_process_output(b"simple ASCII text");
        assert_eq!(result, "simple ASCII text");
    }

    #[test]
    fn test_decode_empty() {
        let result = decode_process_output(b"");
        assert_eq!(result, "");
    }

    #[test]
    fn test_decode_invalid_utf8_fallback() {
        // 0xFF is not valid UTF-8; should fall back to lossy
        let result = decode_process_output(b"bad byte \xFF here");
        assert!(result.contains("bad byte"));
        // The exact replacement depends on lossy decoding
        assert!(result.len() > "bad byte ".len());
    }

    #[test]
    fn test_decode_common_windows_codepages() {
        assert_eq!(
            decode_codepage(&[0xC4, 0xE3, 0xBA, 0xC3], 936),
            Ok("你好".into())
        );
        assert_eq!(
            decode_codepage(&[0xA4, 0xA4, 0xA4, 0xE5], 950),
            Ok("中文".into())
        );
        assert_eq!(
            decode_codepage(&[0x93, 0xFA, 0x96, 0x7B], 932),
            Ok("日本".into())
        );
        assert_eq!(
            decode_codepage(&[0xC7, 0xD1, 0xB1, 0xB9], 949),
            Ok("한국".into())
        );
    }

    #[test]
    fn test_decode_unknown_codepage_is_rejected() {
        assert!(decode_codepage(b"text", 12345).is_err());
    }

    #[test]
    fn test_trim_line_endings() {
        assert_eq!(trim_line_endings(b"hello\n"), b"hello");
        assert_eq!(trim_line_endings(b"hello\r\n"), b"hello");
        assert_eq!(trim_line_endings(b"hello"), b"hello");
        assert_eq!(trim_line_endings(b"\n"), b"");
        assert_eq!(trim_line_endings(b""), b"");
    }
}
