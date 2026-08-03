#!/usr/bin/env python3
"""Rewrite an NPatch APK into a conventional non-overlapping ZIP/APK.

NPatch can reuse local-file records from the embedded origin.apk to reduce size.
Some Android package installers reject that legal-but-nonstandard overlap as an
invalid package. This script materializes every central-directory entry into a
fresh archive, preserves each entry's compression method, and copies origin.apk
from its raw stored bytes because Python's zipfile deliberately refuses to read
that overlapping entry.
"""

from __future__ import annotations

import argparse
import os
import re
import struct
import sys
import zipfile
from pathlib import Path

LOCAL_FILE_HEADER = struct.Struct("<IHHHHHIIIHH")
LOCAL_FILE_SIGNATURE = 0x04034B50
ORIGIN_PATH = "assets/npatch/origin.apk"
SIGNATURE_RE = re.compile(r"^META-INF/[^/]+\.(?:RSA|DSA|EC|SF|MF)$", re.IGNORECASE)


def read_raw_stored_entry(apk_path: Path, info: zipfile.ZipInfo) -> bytes:
    """Read a stored entry directly from its local file record."""
    with apk_path.open("rb") as stream:
        stream.seek(info.header_offset)
        raw_header = stream.read(LOCAL_FILE_HEADER.size)
        if len(raw_header) != LOCAL_FILE_HEADER.size:
            raise RuntimeError(f"truncated local header for {info.filename}")
        (
            signature,
            _version,
            _flags,
            compression,
            _time,
            _date,
            crc,
            compressed_size,
            uncompressed_size,
            name_length,
            extra_length,
        ) = LOCAL_FILE_HEADER.unpack(raw_header)
        if signature != LOCAL_FILE_SIGNATURE:
            raise RuntimeError(f"bad local header signature for {info.filename}")
        name = stream.read(name_length).decode("utf-8")
        stream.seek(extra_length, os.SEEK_CUR)
        if name != info.filename:
            raise RuntimeError(f"local header name mismatch: {name!r} != {info.filename!r}")
        if compression != zipfile.ZIP_STORED:
            raise RuntimeError(f"raw entry is not stored: {info.filename}")
        if compressed_size != uncompressed_size:
            raise RuntimeError(f"stored entry sizes differ: {info.filename}")
        data = stream.read(compressed_size)
        if len(data) != compressed_size:
            raise RuntimeError(f"truncated entry data for {info.filename}")
        if (zipfile.crc32(data) & 0xFFFFFFFF) != crc:
            raise RuntimeError(f"CRC mismatch for raw entry {info.filename}")
        return data


def clean_info(source: zipfile.ZipInfo) -> zipfile.ZipInfo:
    target = zipfile.ZipInfo(source.filename, source.date_time)
    target.compress_type = source.compress_type
    target.comment = source.comment
    target.internal_attr = source.internal_attr
    target.external_attr = source.external_attr
    target.create_system = source.create_system
    target.create_version = source.create_version
    target.extract_version = source.extract_version
    target.flag_bits = source.flag_bits & ~0x08  # let zipfile write fixed sizes
    target.volume = 0
    target.extra = b""  # zipalign will add fresh alignment padding later
    return target


def normalize(input_apk: Path, output_apk: Path) -> None:
    output_apk.parent.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()

    with zipfile.ZipFile(input_apk, "r") as source, zipfile.ZipFile(
        output_apk, "w", allowZip64=True, strict_timestamps=False
    ) as target:
        for info in source.infolist():
            name = info.filename
            if name in seen:
                raise RuntimeError(f"duplicate central-directory name: {name}")
            seen.add(name)
            if SIGNATURE_RE.match(name):
                continue

            if name == ORIGIN_PATH:
                data = read_raw_stored_entry(input_apk, info)
            else:
                try:
                    data = source.read(info)
                except zipfile.BadZipFile as exc:
                    raise RuntimeError(f"cannot materialize {name}: {exc}") from exc

            target.writestr(clean_info(info), data)

    with zipfile.ZipFile(output_apk, "r") as check:
        bad = check.testzip()
        if bad is not None:
            raise RuntimeError(f"normalized APK has a corrupt entry: {bad}")
        names = set(check.namelist())
        required = {
            "AndroidManifest.xml",
            ORIGIN_PATH,
            "assets/npatch/modules/com.bulat.smartbookpinyin.apk",
        }
        missing = sorted(required - names)
        if missing:
            raise RuntimeError(f"normalized APK is missing entries: {missing}")

        ordered = sorted(check.infolist(), key=lambda item: item.header_offset)
        for current, following in zip(ordered, ordered[1:]):
            end_offset = getattr(current, "_end_offset", None)
            if end_offset is None:
                continue
            if end_offset > following.header_offset:
                raise RuntimeError(
                    f"overlapping entries remain: {current.filename} -> {following.filename}"
                )

    print(f"normalized {len(seen):,} entries: {input_apk} -> {output_apk}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_apk", type=Path)
    parser.add_argument("output_apk", type=Path)
    args = parser.parse_args()
    normalize(args.input_apk, args.output_apk)
    return 0


if __name__ == "__main__":
    sys.exit(main())
