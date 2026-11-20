"""Makes the WebP pictures of the website from docs/images: 1600 and 800 pixels wide.

The website shows these instead of the PNG files, which stay for the README.
Run it after a picture in docs/images changes: python3 scripts/site-images.py
It needs Pillow with WebP support.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "images"
TARGET = ROOT / "site" / "images"
PICTURES = ["bug-fixed", "terminal", "terminals", "chat", "modes", "approvals", "handoff", "family", "connect"]


def main() -> None:
    TARGET.mkdir(parents=True, exist_ok=True)
    for name in PICTURES:
        image = Image.open(SOURCE / f"{name}.png").convert("RGB")
        for width in (1600, 800):
            size = (width, round(image.height * width / image.width))
            picture = image if image.width == width else image.resize(size, Image.LANCZOS)
            path = TARGET / f"{name}-{width}.webp"
            picture.save(path, "WEBP", quality=82, method=6)
            print(f"{path.relative_to(ROOT)} {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
