"""Render a comment as an image (a plain chat-style screenshot): the demo / test images for Kev's image path."""
import textwrap

from PIL import Image, ImageDraw, ImageFont


def shot(text: str, font_path: str, size: int = 26) -> Image.Image:
    font = ImageFont.truetype(font_path, size)
    lines = sum((textwrap.wrap(p, 22) or [""] for p in text.split("\n")), [])[:14]
    W, H = 720, 120 + 40 * len(lines)
    im = Image.new("RGB", (W, H), (245, 246, 248)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((24, 24, W - 24, H - 24), 18, fill=(255, 255, 255))
    d.ellipse((44, 44, 84, 84), fill=(200, 205, 214)); d.text((100, 50), "用户评论", font=font, fill=(120, 124, 132))
    for i, ln in enumerate(lines): d.text((48, 100 + 40 * i), ln, font=font, fill=(20, 22, 26))
    return im
