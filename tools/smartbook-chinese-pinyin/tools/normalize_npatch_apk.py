#!/usr/bin/env python3
"""Rewrite an NPatch APK into a conventional non-overlapping ZIP/APK.

NPatch deliberately aliases local-file records from the embedded origin.apk to
reduce output size. Some Android package installers (notably Samsung's) reject
that ZIP layout as an invalid package. Python's zipfile also refuses to read the
aliased records as a possible zip bomb.

This script treats the central directory as authoritative, reads the compressed
bytes for every entry directly from its referenced local-file record, verifies
size and CRC, and writes every entry into a fresh conventional archive.
"""

from __future__ import annotations

import argparse
import binascii
import bz2
import lzma
import os
import re
import struct
import sys
import zipfile
import zlib
from pathlib import Path

LOCAL_FILE_HEADER = struct.Struct("<IHHHHHIIIHH")
LOCAL_FILE_SIGNATURE = 0x04034B50
ORIGIN_PATH = "assets/npatch/origin.apk"
MODULE_PATH = "assets/npatch/modules/com.bulat.smartbookpinyin.apk"
SIGNATURE_RE = re.compile(r"^META-INF/[^/]+\.(?:RSA|DSA|EC|SF|MF)$", re.IGNORECASE)


def decode_entry(raw: bytes, compression: int, name: str) -> bytes:
    if compression == zipfile.ZIP_STORED:
        return raw
    if compression == zipfile.ZIP_DEFLATED:
        return zlib.decompress(raw, -15)
    if compression == zipfile.ZIP_BZIP2:
        return bz2.decompress(raw)
    if compression == zipfile.ZIP_LZMA:
        return lzma.decompress(raw)
    raise RuntimeError(f"unsupported ZIP compression {compression} for {name}")


def read_entry_direct(stream, info: zipfile.ZipInfo) -> bytes:
    """Read one central-directory entry without zipfile's overlap guard."""
    if info.flag_bits & 0x1:
        raise RuntimeError(f"encrypted ZIP entry is unsupported: {info.filename}")

    stream.seek(info.header_offset)
    raw_header = stream.read(LOCAL_FILE_HEADER.size)
    if len(raw_header) != LOCAL_FILE_HEADER.size:
        raise RuntimeError(
            f"truncated local header for {info.filename} at {info.header_offset}"
        )

    (
        signature,
        _version,
        local_flags,
        local_compression,
        _time,
        _date,
        _local_crc,
        _local_compressed_size,
        _local_uncompressed_size,
        name_length,
        extra_length,
    ) = LOCAL_FILE_HEADER.unpack(raw_header)

    if signature != LOCAL_FILE_SIGNATURE:
        raise RuntimeError(
            f"bad local header signature for {info.filename} at {info.header_offset}: "
            f"0x{signature:08x}"
        )
    if local_flags & 0x1:
        raise RuntimeError(f"encrypted local ZIP record: {info.filename}")
    if local_compression != info.compress_type:
        raise RuntimeError(
            f"compression mismatch for {info.filename}: "
            f"local={local_compression}, central={info.compress_type}"
        )

    local_name_raw = stream.read(name_length)
    try:
        local_name = local_name_raw.decode("utf-8")
    except UnicodeDecodeError:
        local_name = local_name_raw.decode("cp437", errors="replace")
    stream.seek(extra_length, os.SEEK_CUR)

    compressed = stream.read(info.compress_size)
    if len(compressed) != info.compress_size:
        raise RuntimeError(
            f"truncated compressed data for {info.filename}: "
            f"wanted={info.compress_size}, got={len(compressed)}, "
            f"local_name={local_name!r}"
        )

    try:
        data = decode_entry(compressed, info.compress_type, info.filename)
    except Exception as exc:
        raise RuntimeError(
            f"cannot decompress {info.filename} from local record {local_name!r} "
            f"at {info.header_offset}: {exc}"
        ) from exc

    if len(data) != info.file_size:
        raise RuntimeError(
            f"size mismatch for {info.filename}: expected={info.file_size}, "
            f"actual={len(data)}, local_name={local_name!r}"
        )
    crc = binascii.crc32(data) & 0xFFFFFFFF
    if crc != info.CRC:
        raise RuntimeError(
            f"CRC mismatch for {info.filename}: expected={info.CRC:08x}, "
            f"actual={crc:08x}, local_name={local_name!r}"
        )
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
    target.flag_bits = source.flag_bits & ~(0x1 | 0x8)
    target.volume = 0
    target.extra = b""  # zipalign will add fresh alignment padding later
    return target


def assert_conventional(apk_path: Path) -> None:
    with zipfile.ZipFile(apk_path, "r") as check:
        bad = check.testzip()
        if bad is not None:
            raise RuntimeError(f"normalized APK has a corrupt entry: {bad}")

        names = set(check.namelist())
        required = {
            "AndroidManifest.xml",
            ORIGIN_PATH,
            MODULE_PATH,
            "classes10.dex",
        }
        missing = sorted(required - names)
        if missing:
            raise RuntimeError(f"normalized APK is missing entries: {missing}")

        ordered = sorted(check.infolist(), key=lambda item: item.header_offset)
        for current, following in zip(ordered, ordered[1:]):
            end_offset = getattr(current, "_end_offset", None)
            if end_offset is not None and end_offset > following.header_offset:
                raise RuntimeError(
                    f"overlapping entries remain: {current.filename} -> {following.filename}"
                )

        # The nested payloads must themselves be ordinary readable APK files.
        for nested_name in (ORIGIN_PATH, MODULE_PATH):
            nested_bytes = check.read(nested_name)
            from io import BytesIO

            with zipfile.ZipFile(BytesIO(nested_bytes), "r") as nested:
                if "AndroidManifest.xml" not in nested.namelist():
                    raise RuntimeError(f"nested APK lacks a manifest: {nested_name}")
                nested_bad = nested.testzip()
                if nested_bad is not None:
                    raise RuntimeError(
                        f"nested APK {nested_name} has corrupt entry: {nested_bad}"
                    )


def normalize(input_apk: Path, output_apk: Path) -> None:
    output_apk.parent.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    written = 0

    with input_apk.open("rb") as raw_stream, zipfile.ZipFile(
        input_apk, "r"
    ) as source, zipfile.ZipFile(
        output_apk, "w", allowZip64=True, strict_timestamps=False
    ) as target:
        for index, info in enumerate(source.infolist(), start=1):
            name = info.filename
            if name in seen:
                raise RuntimeError(f"duplicate central-directory name: {name}")
            seen.add(name)
            if SIGNATURE_RE.match(name):
                continue

            try:
                data = read_entry_direct(raw_stream, info)
            except Exception as exc:
                raise RuntimeError(
                    f"failed at entry {index}/{len(source.infolist())}: {name}: {exc}"
                ) from exc

            target.writestr(clean_info(info), data)
            written += 1
            if written % 1000 == 0:
                print(f"materialized {written:,} entries", flush=True)

    assert_conventional(output_apk)
    print(
        f"normalized {written:,} entries into a conventional APK: "
        f"{input_apk} -> {output_apk}",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_apk", type=Path)
    parser.add_argument("output_apk", type=Path)
    args = parser.parse_args()
    normalize(args.input_apk, args.output_apk)
    return 0


if __name__ == "__main__":
    sys.exit(main())
