"""Create clean, web-ready CFLS brand assets from the supplied master PNGs.

The source images remain untouched. This utility exports a high-density README
banner and a clean square product mark with transparent corners, then copies
the web-hosted variants into ``website/assets``.
"""

from __future__ import annotations

import argparse
import shutil
from collections import deque
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


BRAND_DARK = (4, 6, 8)
OUTPUT_BANNER_WIDTH = 2560
OUTPUT_MARK_SIZE = 1024


def is_lime(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, _ = pixel
    return green > 135 and red > 85 and blue < 180 and green > red + 28


def is_outer_dark(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, _ = pixel
    return max(red, green, blue) < 42 and max(red, green, blue) - min(red, green, blue) < 24


def lime_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    pixels = image.load()
    left, top, right, bottom = image.width, image.height, -1, -1
    for y in range(image.height):
        for x in range(image.width):
            if is_lime(pixels[x, y]):
                left = min(left, x)
                top = min(top, y)
                right = max(right, x)
                bottom = max(bottom, y)
    if right < left or bottom < top:
        raise ValueError("Could not find the lime CFLS mark in the supplied logo.")
    # Keep a small antialiased edge around the rounded square.
    inset = 3
    return (
        max(0, left - inset),
        max(0, top - inset),
        min(image.width, right + inset + 1),
        min(image.height, bottom + inset + 1),
    )


def remove_outer_dark_corners(image: Image.Image) -> Image.Image:
    """Make only border-connected dark pixels transparent.

    The black share glyph is fully enclosed by the lime rounded square, so it
    remains opaque while the source image's large black background disappears.
    """

    result = image.convert("RGBA")
    pixels = result.load()
    width, height = result.size
    seen = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def enqueue(x: int, y: int) -> None:
        index = y * width + x
        if seen[index] or not is_outer_dark(pixels[x, y]):
            return
        seen[index] = 1
        queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        red, green, blue, _ = pixels[x, y]
        pixels[x, y] = (red, green, blue, 0)
        for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= next_x < width and 0 <= next_y < height:
                enqueue(next_x, next_y)
    return result


def clean_mark(source: Path) -> Image.Image:
    original = Image.open(source).convert("RGBA")
    mark = original.crop(lime_bounds(original))
    mark = remove_outer_dark_corners(mark)
    mark = mark.resize((OUTPUT_MARK_SIZE, OUTPUT_MARK_SIZE), Image.Resampling.LANCZOS)
    return mark.filter(ImageFilter.UnsharpMask(radius=0.7, percent=42, threshold=5))


def clean_banner(source: Path) -> Image.Image:
    original = Image.open(source).convert("RGB")
    # Preserve the supplied composition and text. Only normalize nearly-black
    # background noise and apply a restrained contrast/sharpen pass.
    pixels = original.load()
    for y in range(original.height):
        for x in range(original.width):
            red, green, blue = pixels[x, y]
            if red <= 12 and green <= 15 and blue <= 18:
                pixels[x, y] = BRAND_DARK
    contrasted = ImageEnhance.Contrast(original).enhance(1.045)
    height = round(contrasted.height * OUTPUT_BANNER_WIDTH / contrasted.width)
    banner = contrasted.resize((OUTPUT_BANNER_WIDTH, height), Image.Resampling.LANCZOS)
    return banner.filter(ImageFilter.UnsharpMask(radius=0.65, percent=35, threshold=6))


def save_png(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True, compress_level=9)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--logo", type=Path, required=True, help="Path to the provided CFLS logo PNG.")
    parser.add_argument("--banner", type=Path, required=True, help="Path to the provided CFLS banner PNG.")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()

    repo = args.repo.resolve()
    assets = repo / "assets" / "brand"
    website_assets = repo / "website" / "assets"

    mark_path = assets / "cfls-mark.png"
    banner_path = assets / "cfls-banner.png"
    save_png(clean_mark(args.logo), mark_path)
    save_png(clean_banner(args.banner), banner_path)

    website_assets.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(mark_path, website_assets / "cfls-mark.png")
    shutil.copyfile(banner_path, website_assets / "cfls-banner.png")

    favicon = Image.open(mark_path).convert("RGBA").resize((256, 256), Image.Resampling.LANCZOS)
    save_png(favicon, repo / "website" / "favicon.png")

    print(f"Wrote {mark_path.relative_to(repo)}")
    print(f"Wrote {banner_path.relative_to(repo)}")
    print(f"Wrote {(website_assets / 'cfls-mark.png').relative_to(repo)}")
    print(f"Wrote {(website_assets / 'cfls-banner.png').relative_to(repo)}")
    print(f"Wrote {(repo / 'website' / 'favicon.png').relative_to(repo)}")


if __name__ == "__main__":
    main()
