#!/usr/bin/env python3
"""Draws the 1024x1024 app icon: a white microphone on orange. watchOS masks it to a circle."""
import sys
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGB", (S, S), (255, 120, 30))
d = ImageDraw.Draw(img)
white = (255, 255, 255)
# capsule head
d.rounded_rectangle([392, 210, 632, 590], radius=120, fill=white)
# cradle arc
d.arc([300, 330, 724, 700], start=0, end=180, fill=white, width=44)
# stem and base
d.rectangle([490, 690, 534, 800], fill=white)
d.rounded_rectangle([400, 790, 624, 834], radius=22, fill=white)
img.save(sys.argv[1])
