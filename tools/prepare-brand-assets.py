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
BRAND_LIME = (214, 245, 74)
BRAND_INK = (5, 9, 11)
OUTPUT_BANNER_WIDTH = 2560
OUTPUT_MARK_SIZE = 1024


def is_lime(pixel: tuple[int, int, int, int]) -> bool:
    red, green, blue, _ = pixel
    return green > 135 and red > 85 and blue < 180 and green > red + 28


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


def clean_mark(source: Path) -> Image.Image:
    original = Image.open(source).convert("RGBA")
    cropped = original.crop(lime_bounds(original))

    # The supplied mark has subtle generated-image grain. Preserve its exact
    # share-glyph silhouette, but render it in the banner's flat, canonical
    # lime and ink so both assets share one clean identity.
    glyph = Image.new("L", cropped.size, 0)
    source_pixels = cropped.load()
    glyph_pixels = glyph.load()

    def is_glyph_pixel(x: int, y: int) -> bool:
        red, green, blue, alpha = source_pixels[x, y]
        return alpha > 0 and max(red, green, blue) < 88

    # Start inside the left/root node and trace only its connected dark
    # component. This prevents the baked black background from becoming part
    # of the new flat mark.
    center_x = round(cropped.width * 0.3)
    center_y = round(cropped.height * 0.5)
    seed: tuple[int, int] | None = None
    for radius in range(0, round(min(cropped.size) * 0.12), 8):
        for offset_x, offset_y in ((0, 0), (radius, 0), (-radius, 0), (0, radius), (0, -radius)):
            x, y = center_x + offset_x, center_y + offset_y
            if 0 <= x < cropped.width and 0 <= y < cropped.height and is_glyph_pixel(x, y):
                seed = (x, y)
                break
        if seed:
            break
    if seed is None:
        raise ValueError("Could not isolate the dark CFLS share glyph in the supplied logo.")

    visited: set[tuple[int, int]] = {seed}
    queue: deque[tuple[int, int]] = deque([seed])
    while queue:
        x, y = queue.popleft()
        glyph_pixels[x, y] = 255
        for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            point = (next_x, next_y)
            if (
                0 <= next_x < cropped.width
                and 0 <= next_y < cropped.height
                and point not in visited
                and is_glyph_pixel(next_x, next_y)
            ):
                visited.add(point)
                queue.append(point)

    glyph = glyph.resize((OUTPUT_MARK_SIZE, OUTPUT_MARK_SIZE), Image.Resampling.LANCZOS)
    result = Image.new("RGBA", (OUTPUT_MARK_SIZE, OUTPUT_MARK_SIZE), (0, 0, 0, 0))
    radius = round(OUTPUT_MARK_SIZE * 0.265)
    rounded_square = Image.new("L", (OUTPUT_MARK_SIZE, OUTPUT_MARK_SIZE), 0)
    rounded_pixels = Image.new("RGBA", (OUTPUT_MARK_SIZE, OUTPUT_MARK_SIZE), BRAND_LIME + (255,))
    from PIL import ImageDraw

    ImageDraw.Draw(rounded_square).rounded_rectangle(
        (0, 0, OUTPUT_MARK_SIZE - 1, OUTPUT_MARK_SIZE - 1), radius=radius, fill=255
    )
    result.alpha_composite(Image.composite(rounded_pixels, Image.new("RGBA", result.size), rounded_square))
    ink = Image.new("RGBA", result.size, BRAND_INK + (255,))
    result.alpha_composite(Image.composite(ink, Image.new("RGBA", result.size), glyph))
    return result


def clean_banner(source: Path) -> Image.Image:
    original = Image.open(source).convert("RGB")
    # Remove the large export matte around the actual rounded banner panel.
    # The panel has a visible slate border/grid, while the surrounding export
    # frame is near-black.
    source_pixels = original.load()
    left, top, right, bottom = original.width, original.height, -1, -1
    for y in range(original.height):
        for x in range(original.width):
            red, green, blue = source_pixels[x, y]
            if max(red, green, blue) > 42:
                left = min(left, x)
                top = min(top, y)
                right = max(right, x)
                bottom = max(bottom, y)
    if right < left or bottom < top:
        raise ValueError("Could not find the CFLS banner panel in the supplied image.")
    original = original.crop((left, top, right + 1, bottom + 1))

    # Preserve the supplied copy and composition. Only normalize nearly-black
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
    extension = repo / "apps" / "vscode-extension"

    mark_path = assets / "cfls-mark.png"
    banner_path = assets / "cfls-banner.png"
    save_png(clean_mark(args.logo), mark_path)
    save_png(clean_banner(args.banner), banner_path)

    website_assets.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(mark_path, website_assets / "cfls-mark.png")
    shutil.copyfile(banner_path, website_assets / "cfls-banner.png")
    shutil.copyfile(mark_path, extension / "icon.png")
    shutil.copyfile(mark_path, extension / "vsix-pkg" / "icon.png")

    favicon = Image.open(mark_path).convert("RGBA").resize((256, 256), Image.Resampling.LANCZOS)
    save_png(favicon, repo / "website" / "favicon.png")

    print(f"Wrote {mark_path.relative_to(repo)}")
    print(f"Wrote {banner_path.relative_to(repo)}")
    print(f"Wrote {(website_assets / 'cfls-mark.png').relative_to(repo)}")
    print(f"Wrote {(website_assets / 'cfls-banner.png').relative_to(repo)}")
    print(f"Wrote {(repo / 'website' / 'favicon.png').relative_to(repo)}")
    print(f"Wrote {(extension / 'icon.png').relative_to(repo)}")
    print(f"Wrote {(extension / 'vsix-pkg' / 'icon.png').relative_to(repo)}")


if __name__ == "__main__":
    main()
