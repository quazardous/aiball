#!/usr/bin/env python3
"""
Generate assets/aiball.ico from assets/aiball-src.jpg.

The source is a pixel-art image on a white-with-grid background plus a
watermark band at the bottom. This script:

1. Crops the watermark band (~7% bottom).
2. Threshold-detours near-white pixels (RGB > 200) to transparent.
3. Connected-components pass: keeps only the largest opaque cluster
   (= the subject) and wipes everything else — kills JPG edge artifacts,
   grid-line fragments, and any orphan pixel soup.
4. Tight-bbox crops, pads to square with ~10% breathing room.
5. Writes a multi-resolution ICO (16/24/32/48/64/128/256) with
   PNG-encoded entries; uses NEAREST resampling at small sizes to
   preserve pixel-art crispness.

Re-run after changing assets/aiball-src.jpg:

    python scripts/make-icon.py

Requires Pillow (`pip install pillow`).
"""

import io
import os
import struct
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "aiball-src.jpg"
ICO = ROOT / "assets" / "aiball.ico"
PREVIEW = ROOT / "assets" / "aiball-preview.png"

WATERMARK_FRAC = 0.07    # bottom band to crop (Prohama.com strip)
WHITE_THRESHOLD = 200    # RGB above this on all channels -> transparent
PAD_FRAC = 0.10          # extra breathing room around the subject
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def detour_background(img: Image.Image) -> Image.Image:
    """Threshold near-white pixels to transparent."""
    px = img.load()
    W, H = img.size
    for y in range(H):
        for x in range(W):
            r, g, b, _ = px[x, y]
            if r > WHITE_THRESHOLD and g > WHITE_THRESHOLD and b > WHITE_THRESHOLD:
                px[x, y] = (0, 0, 0, 0)
    return img


def keep_largest_component(img: Image.Image) -> Image.Image:
    """BFS all opaque clusters, wipe everything except the biggest."""
    W, H = img.size
    px = img.load()
    visited = [[False] * W for _ in range(H)]
    clusters: list[list[tuple[int, int]]] = []
    for y0 in range(H):
        for x0 in range(W):
            if visited[y0][x0]:
                continue
            if px[x0, y0][3] == 0:
                visited[y0][x0] = True
                continue
            q = deque([(x0, y0)])
            visited[y0][x0] = True
            pixels: list[tuple[int, int]] = []
            while q:
                x, y = q.popleft()
                pixels.append((x, y))
                for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and not visited[ny][nx]:
                        visited[ny][nx] = True
                        if px[nx, ny][3] != 0:
                            q.append((nx, ny))
            clusters.append(pixels)
    clusters.sort(key=len, reverse=True)
    print(f"  clusters: {len(clusters)} (top sizes: {[len(c) for c in clusters[:5]]})")
    keep = set(clusters[0])
    for y in range(H):
        for x in range(W):
            if (x, y) not in keep and px[x, y][3] != 0:
                px[x, y] = (0, 0, 0, 0)
    return img


def pad_square(img: Image.Image, margin: float) -> Image.Image:
    w, h = img.size
    side = int(max(w, h) * (1 + 2 * margin))
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return square


def write_ico(img: Image.Image, path: Path, sizes: list[int]) -> None:
    """Write a multi-resolution ICO with PNG-encoded entries.

    Pillow's built-in `save(format="ICO", sizes=...)` rasterizes each entry
    from the base image with a default resampling that blurs pixel art at
    small sizes. We resize each entry ourselves with NEAREST (<= 64) or
    LANCZOS (> 64), then bundle the PNGs into an ICO file manually.
    """
    blobs: list[bytes] = []
    for s in sizes:
        resampling = Image.NEAREST if s <= 64 else Image.LANCZOS
        bio = io.BytesIO()
        img.resize((s, s), resampling).save(bio, format="PNG")
        blobs.append(bio.getvalue())

    with open(path, "wb") as f:
        # ICONDIR: reserved=0, type=1 (icon), count
        f.write(struct.pack("<HHH", 0, 1, len(sizes)))
        # ICONDIRENTRY for each, then image data
        offset = 6 + 16 * len(sizes)
        for i, s in enumerate(sizes):
            wb = s if s < 256 else 0    # 0 means 256 per spec
            hb = s if s < 256 else 0
            f.write(struct.pack(
                "<BBBBHHII",
                wb, hb,
                0,         # palette colors (0 = no palette)
                0,         # reserved
                1,         # color planes
                32,        # bits per pixel
                len(blobs[i]),
                offset,
            ))
            offset += len(blobs[i])
        for blob in blobs:
            f.write(blob)


def main() -> int:
    if not SRC.exists():
        print(f"error: source image missing: {SRC}", file=sys.stderr)
        return 1

    print(f"Reading {SRC.relative_to(ROOT)}")
    src = Image.open(SRC).convert("RGBA")
    W, H = src.size

    print(f"  crop watermark band (bottom {int(WATERMARK_FRAC*100)}%)")
    src = src.crop((0, 0, W, int(H * (1 - WATERMARK_FRAC))))

    print(f"  detour pixels brighter than {WHITE_THRESHOLD}")
    src = detour_background(src)

    print(f"  keep largest connected component")
    src = keep_largest_component(src)

    bbox = src.getbbox()
    src = src.crop(bbox)
    print(f"  tight bbox: {src.size}")

    square = pad_square(src, PAD_FRAC)
    print(f"  padded square: {square.size}")

    # Visual preview (gitignored — for human verification only)
    square.resize((256, 256), Image.NEAREST).save(PREVIEW, format="PNG")
    print(f"  wrote {PREVIEW.relative_to(ROOT)} (preview)")

    write_ico(square, ICO, ICO_SIZES)
    size_kb = os.path.getsize(ICO) / 1024
    print(f"  wrote {ICO.relative_to(ROOT)} ({size_kb:.1f} KB, {len(ICO_SIZES)} resolutions)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
