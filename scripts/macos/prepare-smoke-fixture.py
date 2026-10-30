#!/usr/bin/env python3
"""Extract the fixed CC0 40-photo M0 subset without changing any source image.

For slow downloads, --archive-tail accepts a separately fetched final 65536 bytes
of the same immutable Figshare file. Only entries wholly present in --archive
can then be read; ZIP CRC and per-photo SHA-256 are still checked. Such a subset
is explicitly marked as awaiting whole-archive verification.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile


ARCHIVE_SIZE = 611535084
ARCHIVE_MD5 = "a62826fd45a89551a548897cf6b62b01"
ARCHIVE_SHA256 = "b0d0995be5652d453fdb0d809a364ccd4a8a5040cae35fb6e748f0ff1783d2d1"
FILES = ["IMG_" + str(index) + ".jpg" for index in range(1928, 1968)]


def digest(path, algorithm):
    result = hashlib.new(algorithm)
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


class PartialZip(io.RawIOBase):
    """A read-only sparse view; missing bytes always fail rather than zero-fill."""
    def __init__(self, prefix, tail):
        self.prefix = Path(prefix).open("rb")
        self.prefix_size = Path(prefix).stat().st_size
        self.tail = Path(tail).read_bytes()
        if len(self.tail) != 65536 or self.prefix_size >= ARCHIVE_SIZE:
            self.prefix.close()
            raise ValueError("Partial mode requires a partial archive and exactly 65536 tail bytes")
        self.position = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def seek(self, offset, whence=0):
        position = offset + (self.position if whence == 1 else ARCHIVE_SIZE if whence == 2 else 0)
        if position < 0 or whence not in (0, 1, 2):
            raise ValueError("Invalid ZIP seek")
        self.position = position
        return position

    def tell(self):
        return self.position

    def read(self, size=-1):
        if self.position >= ARCHIVE_SIZE:
            return b""
        size = min(size if size >= 0 else ARCHIVE_SIZE, ARCHIVE_SIZE - self.position)
        if self.position >= ARCHIVE_SIZE - len(self.tail):
            start = self.position - (ARCHIVE_SIZE - len(self.tail))
            data = self.tail[start:start + size]
        elif self.position + size <= self.prefix_size:
            self.prefix.seek(self.position)
            data = self.prefix.read(size)
        else:
            raise ValueError("Selected photo bytes are not downloaded yet")
        self.position += len(data)
        return data

    def close(self):
        self.prefix.close()
        super().close()


def prepare(archive, output, tail=None):
    archive, output = Path(archive), Path(output)
    if output.exists():
        raise ValueError("Use a fresh output directory; fixtures are never overwritten")
    metadata = {"expected_size": ARCHIVE_SIZE, "expected_md5": ARCHIVE_MD5,
                "expected_sha256": ARCHIVE_SHA256,
                "file_id": 16636739, "url": "https://ndownloader.figshare.com/files/16636739"}
    if tail:
        stream = PartialZip(archive, tail)
        metadata["whole_archive_verification"] = "pending_partial_download"
    else:
        if archive.stat().st_size != ARCHIVE_SIZE or digest(archive, "md5") != ARCHIVE_MD5:
            raise ValueError("Figshare archive size or provider MD5 mismatch")
        archive_sha256 = digest(archive, "sha256")
        if archive_sha256 != ARCHIVE_SHA256:
            raise ValueError("Figshare archive does not match the locked SHA-256")
        stream = archive.open("rb")
        metadata.update(whole_archive_verification="passed", sha256=archive_sha256)
    manifest = {
        "schema_version": 1, "id": "james-sample-cc0-40-v1", "kind": "real_photographs",
        "title": "James et al. 2012 sample-scale volcanic bomb (40-photo subset)",
        "source": "https://doi.org/10.6084/m9.figshare.9120020.v1",
        "license": "CC0-1.0", "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "license_evidence": "https://api.figshare.com/v2/articles/9120020/versions/1",
        "authors": ["Mike R. James", "Stuart Robson"], "archive": metadata,
        "selection": "Unmodified IMG_1928.jpg through IMG_1967.jpg, inclusive",
        "images": [],
    }
    try:
        with zipfile.ZipFile(stream) as zipped:
            # Read all selected entries first. Missing download bytes cannot leave
            # an apparently complete manifest or a partly accepted fixture.
            entries = [(name, zipped.read(name), zipped.getinfo(name).CRC) for name in FILES]
        output.mkdir(parents=True)
        (output / "images").mkdir()
        for name, data, crc in entries:
            (output / "images" / name).write_bytes(data)
            manifest["images"].append({"path": name, "bytes": len(data), "zip_crc32": format(crc, "08x"),
                                       "sha256": hashlib.sha256(data).hexdigest()})
        (output / "fixture.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    finally:
        stream.close()
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--archive-tail", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest = prepare(args.archive, args.output, args.archive_tail)
        print(str(len(manifest["images"])) + " CRC-checked photos extracted; " +
              manifest["archive"]["whole_archive_verification"])
        return 0
    except (OSError, ValueError, zipfile.BadZipFile, KeyError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
