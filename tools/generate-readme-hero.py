"""Render the high-resolution static CFLS hero used by the GitHub README.

The banner is deliberately drawn from project-native primitives rather than a
generic generated mock-up: its logo, claims, and coordination flow match the
actual product. Run with the bundled Codex Python runtime when Pillow is not
available on the system interpreter.
"""

from __future__ import annotations

from math import sin, tau
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


WIDTH, HEIGHT = 1280, 400
FRAME_COUNT = 24
SCENE_FRAME = 18
OUTPUT_SCALE = 2

ROOT = Path(__file__).resolve().parent.parent
ASSET_DIR = ROOT / "assets" / "readme"
LEGACY_GIF_PATH = ASSET_DIR / "cfls-hero.gif"
PNG_PATH = ASSET_DIR / "cfls-hero.png"

FONT_DIR = Path(r"C:\Windows\Fonts")
SANS = FONT_DIR / "segoeui.ttf"
SANS_BOLD = FONT_DIR / "segoeuib.ttf"
MONO = FONT_DIR / "consola.ttf"
MONO_BOLD = FONT_DIR / "consolab.ttf"

CANVAS = "#0B1114"
DEEP = "#070B0D"
SURFACE = "#111A1E"
SURFACE_RAISED = "#162126"
TEXT = "#EDF5F3"
MUTED = "#9BADAA"
DIM = "#657674"
LIME = "#C4F36D"
CYAN = "#62E6E0"
AMBER = "#FFC267"
RED = "#FF8D86"


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size)


def rgba(value: str, alpha: int = 255) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16), alpha)


def mix(left: tuple[int, int, int], right: tuple[int, int, int], fraction: float) -> tuple[int, int, int]:
    return tuple(round(a * (1 - fraction) + b * fraction) for a, b in zip(left, right))


def tracked_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    value: str,
    text_font: ImageFont.FreeTypeFont,
    fill: str | tuple[int, int, int, int],
    tracking: float,
) -> None:
    x, y = xy
    for character in value:
        draw.text((x, y), character, font=text_font, fill=fill)
        x += int(draw.textlength(character, font=text_font) + tracking)


def rounded_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    *,
    fill: str,
    outline: str,
    radius: int = 12,
    alpha: int = 255,
) -> None:
    draw.rounded_rectangle(
        box,
        radius=radius,
        fill=rgba(fill, alpha),
        outline=rgba(outline, min(alpha, 180)),
        width=1,
    )


def draw_logo(draw: ImageDraw.ImageDraw, x: int, y: int, size: int) -> None:
    """Draw the landing page's three-node CFLS mark at banner scale.

    The numbers below are the `viewBox="0 0 36 36"` geometry from the
    website header, placed inside the same 32px-to-24px icon proportion used
    by `.brand-mark`. Keeping that source geometry avoids a second, almost-
    matching version of the product mark in the README artwork.
    """
    rounded_panel(
        draw,
        (x, y, x + size, y + size),
        fill=LIME,
        outline=LIME,
        radius=round(size * (9 / 32)),
    )
    glyph_size = size * (24 / 32)
    glyph_x = x + (size - glyph_size) / 2
    glyph_y = y + (size - glyph_size) / 2
    scale = glyph_size / 36
    line = max(1, round(2.4 * scale))
    ink = rgba(CANVAS)

    def point(px: float, py: float) -> tuple[int, int]:
        return (round(glyph_x + px * scale), round(glyph_y + py * scale))

    def rounded_line(start: tuple[int, int], end: tuple[int, int]) -> None:
        draw.line((start, end), fill=ink, width=line)
        cap_radius = line / 2
        for cx, cy in (start, end):
            draw.ellipse(
                (cx - cap_radius, cy - cap_radius, cx + cap_radius, cy + cap_radius),
                fill=ink,
            )

    # Exact landing-page path: top link, bottom link, then the diagonal.
    rounded_line(point(9.5, 11.5), point(17.8, 11.5))
    rounded_line(point(18.2, 24.5), point(26.5, 24.5))
    rounded_line(point(18.1, 11.5), point(25.4, 24.5))

    radius = round(3.3 * scale)
    for cx, cy in (point(8.5, 11.5), point(27.5, 24.5), point(19, 11.5)):
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=ink)


def draw_host_icon(draw: ImageDraw.ImageDraw, x: int, y: int, size: int, color: str) -> None:
    inset = round(size * 0.22)
    left, top = x + inset, y + inset
    right, bottom = x + size - inset, y + size - inset
    mid_x = (left + right) // 2
    mid_y = (top + bottom) // 2
    stroke = max(2, round(size * 0.042))
    draw.polygon(
        [(mid_x, top), (right, top + (bottom - top) // 4), (right, bottom - (bottom - top) // 4), (mid_x, bottom), (left, bottom - (bottom - top) // 4), (left, top + (bottom - top) // 4)],
        outline=rgba(color),
        width=stroke,
    )
    draw.line((left, top + (bottom - top) // 4, mid_x, mid_y), fill=rgba(color), width=stroke)
    draw.line((right, top + (bottom - top) // 4, mid_x, mid_y), fill=rgba(color), width=stroke)
    draw.line((mid_x, mid_y, mid_x, bottom), fill=rgba(color), width=stroke)


def glow_layer(center: tuple[int, int], radius: int, color: str, opacity: int) -> Image.Image:
    layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    glow = ImageDraw.Draw(layer)
    cx, cy = center
    glow.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        fill=rgba(color, opacity),
    )
    return layer.filter(ImageFilter.GaussianBlur(radius=radius // 2))


def draw_status_panel(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    person: str,
    editor: str,
    title: str,
    detail: str,
    tone: str,
    activity: float,
) -> None:
    x1, y1, x2, y2 = box
    rounded_panel(draw, box, fill=SURFACE, outline="#2B3C42", radius=11, alpha=245)
    draw.rounded_rectangle((x1 + 10, y1 + 11, x1 + 18, y1 + 19), radius=4, fill=rgba(tone))
    tracked_text(draw, (x1 + 25, y1 + 8), person.upper(), font(MONO_BOLD, 8), rgba(MUTED), 1.6)
    draw.text((x1 + 11, y1 + 28), title, font=font(SANS_BOLD, 12), fill=rgba(TEXT))
    draw.text((x1 + 11, y1 + 45), detail, font=font(MONO, 8), fill=rgba(MUTED))
    chip_width = int(draw.textlength(editor.upper(), font=font(MONO_BOLD, 7))) + 18
    chip = (x2 - chip_width - 10, y1 + 9, x2 - 10, y1 + 23)
    draw.rounded_rectangle(chip, radius=6, fill=rgba(tone, 22), outline=rgba(tone, 120), width=1)
    tracked_text(draw, (chip[0] + 8, chip[1] + 3), editor.upper(), font(MONO_BOLD, 7), rgba(tone), 0.8)
    if activity > 0:
        glow_alpha = round(70 * activity)
        draw.ellipse((x2 - 18, y2 - 18, x2 - 10, y2 - 10), fill=rgba(tone, glow_alpha))
        draw.ellipse((x2 - 16, y2 - 16, x2 - 12, y2 - 12), fill=rgba(tone))


def draw_connection(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[int, int]],
    progress: float,
    active: bool,
) -> None:
    for first, second in zip(points, points[1:]):
        draw.line((first, second), fill=rgba(CYAN, 70 if active else 30), width=2)
    if not active:
        return
    segments = list(zip(points, points[1:]))
    lengths = [((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 for (x1, y1), (x2, y2) in segments]
    total = sum(lengths)
    marker = (progress % 1) * total
    for ((x1, y1), (x2, y2)), length in zip(segments, lengths):
        if marker <= length:
            ratio = marker / length if length else 0
            px = x1 + (x2 - x1) * ratio
            py = y1 + (y2 - y1) * ratio
            draw.ellipse((px - 6, py - 6, px + 6, py + 6), fill=rgba(CYAN, 60))
            draw.ellipse((px - 3, py - 3, px + 3, py + 3), fill=rgba(CYAN))
            break
        marker -= length


def draw_footer_proof(draw: ImageDraw.ImageDraw, x: int, label: str, tone: str) -> int:
    draw.ellipse((x, 365, x + 6, 371), fill=rgba(tone))
    tracked_text(draw, (x + 13, 361), label, font(MONO_BOLD, 8), rgba(MUTED), 1.1)
    return x + 13 + int(draw.textlength(label, font=font(MONO_BOLD, 8))) + 41


def render_frame(index: int) -> Image.Image:
    phase = index / FRAME_COUNT
    pulse = (sin((phase * tau) * 2) + 1) / 2
    stage = int((phase * 3) % 3)

    base = Image.new("RGBA", (WIDTH, HEIGHT), rgba(CANVAS))
    draw = ImageDraw.Draw(base)

    # Deep editorial surface and a faint technical grid.
    deep = rgba(DEEP)
    surface = rgba(SURFACE)
    for x in range(WIDTH):
        fraction = x / (WIDTH - 1)
        color = mix(deep[:3], surface[:3], fraction * 0.62)
        draw.line((x, 0, x, HEIGHT), fill=(*color, 255))
    for x in range(16, WIDTH, 28):
        for y in range(16, HEIGHT, 28):
            alpha = 23 if x < 760 else 34
            draw.ellipse((x, y, x + 1, y + 1), fill=rgba("#C7E4E0", alpha))

    base.alpha_composite(glow_layer((1022, 198), 145, CYAN, 25 + round(16 * pulse)))
    base.alpha_composite(glow_layer((1200, 68), 110, LIME, 11))
    draw = ImageDraw.Draw(base)
    draw.rounded_rectangle((0, 0, WIDTH - 1, HEIGHT - 1), radius=21, outline=rgba("#304147", 150), width=1)
    draw.line((72, 337, 1208, 337), fill=rgba("#C4DBDC", 28), width=1)

    # Left product identity and copy.
    draw_logo(draw, 72, 118, 70)
    draw.line((176, 101, 176, 289), fill=rgba("#C4DBDC", 40), width=1)
    tracked_text(
        draw,
        (216, 101),
        "CFLS · COLLABORATIVE FILE LOCK SYNC",
        font(MONO_BOLD, 10),
        rgba(MUTED),
        2.1,
    )
    draw.text((216, 135), "Coordinate parallel code,", font=font(SANS_BOLD, 38), fill=rgba(TEXT))
    draw.text((216, 180), "before it collides.", font=font(SANS_BOLD, 40), fill=rgba(LIME))
    draw.rounded_rectangle((217, 239, 296, 243), radius=2, fill=rgba(CYAN))
    draw.text(
        (216, 259),
        "Live work signals for developers and AI coding agents —",
        font=font(SANS, 14),
        fill=rgba(MUTED),
    )
    draw.text((216, 279), "while Git keeps the source.", font=font(SANS, 14), fill=rgba(MUTED))

    # Right: a real product story, with a pulse travelling from Alice to Host to Bob.
    alice = (764, 102, 954, 170)
    bob = (1054, 235, 1240, 303)
    host_center = (1013, 189)
    inbound_active = stage in (0, 1)
    outbound_active = stage in (1, 2)
    draw_connection(draw, [(954, 137), (987, 137), (1013, 165)], phase * 2.6, inbound_active)
    draw_connection(draw, [(1035, 210), (1062, 210), (1062, 248)], (phase * 2.6) - 0.46, outbound_active)

    alice_activity = 0.65 + pulse * 0.35
    bob_activity = 0.35 + (pulse * 0.65 if stage == 2 else 0)
    draw_status_panel(
        draw,
        alice,
        "Alice",
        "VS Code",
        "editing payments.ts",
        "signed work signal",
        LIME,
        alice_activity,
    )
    bob_title = ("chooses safe next task" if stage == 2 else "sees shared context")
    bob_detail = ("clear path · no overlap" if stage == 2 else "payments.ts · coordinate")
    bob_tone = LIME if stage == 2 else AMBER
    draw_status_panel(draw, bob, "Bob", "Kiro", bob_title, bob_detail, bob_tone, bob_activity)

    ring = 46 + round(pulse * 7)
    for radius, alpha, width in ((ring + 20, 28, 1), (ring + 7, 55, 1), (ring - 8, 110, 1)):
        draw.ellipse(
            (host_center[0] - radius, host_center[1] - radius, host_center[0] + radius, host_center[1] + radius),
            outline=rgba(CYAN, alpha),
            width=width,
        )
    draw.ellipse(
        (host_center[0] - 34, host_center[1] - 34, host_center[0] + 34, host_center[1] + 34),
        fill=rgba("#10242A"),
        outline=rgba(CYAN, 205),
        width=2,
    )
    draw_host_icon(draw, host_center[0] - 21, host_center[1] - 27, 42, CYAN)
    tracked_text(draw, (host_center[0] - 27, host_center[1] + 17), "CFLS HOST", font(MONO_BOLD, 7), rgba(CYAN), 0.9)

    # Animate the explanatory phase label rather than pretending this is a live screenshot.
    labels = (
        ("01  ALICE EDITS", LIME),
        ("02  HOST SIGNALS", CYAN),
        ("03  BOB DECIDES", LIME),
    )
    label, label_tone = labels[stage]
    panel = (786, 311, 1210, 330)
    rounded_panel(draw, panel, fill="#0C161A", outline="#2A4044", radius=9, alpha=235)
    draw.ellipse((800, 317, 806, 323), fill=rgba(label_tone))
    tracked_text(draw, (814, 315), label, font(MONO_BOLD, 8), rgba(label_tone), 1.35)
    draw.text((952, 314), "metadata only · source stays in Git", font=font(MONO, 8), fill=rgba(MUTED))

    # Footer proof points.
    footer_x = 72
    footer_x = draw_footer_proof(draw, footer_x, "SOURCE STAYS IN GIT", LIME)
    footer_x = draw_footer_proof(draw, footer_x, "PER-DEVICE KEYS", CYAN)
    draw_footer_proof(draw, footer_x, "SHARED RISK SIGNALS", AMBER)

    return base.convert("RGB")


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    scene = render_frame(SCENE_FRAME)
    # Author at 2x the displayed width so GitHub's 1280px presentation stays
    # crisp on high-density screens without GIF palette compression.
    high_resolution = scene.resize(
        (WIDTH * OUTPUT_SCALE, HEIGHT * OUTPUT_SCALE),
        Image.Resampling.LANCZOS,
    )
    high_resolution.save(PNG_PATH, format="PNG", optimize=True, compress_level=9)
    if LEGACY_GIF_PATH.exists():
        LEGACY_GIF_PATH.unlink()
    print(f"Wrote {PNG_PATH.relative_to(ROOT)} ({PNG_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
