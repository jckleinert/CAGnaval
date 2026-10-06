#!/usr/bin/env python3
"""
Turns the drawings in art/foods/<level>/ into what the game uses.

For each level folder it reads up to four drawings of the same food, all the
same size and with the food in the same place:
    open.png    normal face (the only one that is required)
    half.png    eyes half closed      (optional, falls back to closed/open)
    closed.png  eyes closed           (optional, falls back to open)
    wow.png     surprised face        (optional, falls back to open)

A folder may also hold art.json with settings for that food:
    {"outline": 22}   thicken the dark outline by this many pixels of the drawing, outwards.
                      Small foods need it: drawn with the same line as the big ones, theirs
                      almost vanishes once the food is shrunk to its size in the jar.

and writes:
    web/img/foods/<level>.webp   the different faces side by side, cut square
    scripts/art.json             the outline of each drawing, for gen-foods.js

Needs Pillow and numpy. Run it, then run: node scripts/gen-foods.js
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'art', 'foods')
OUT = os.path.join(ROOT, 'web', 'img', 'foods')
FACES = ['open', 'half', 'closed', 'wow']
FALLBACK = {'half': ['closed', 'open'], 'closed': ['open'], 'wow': ['open']}
OUTLINE_POINTS = 16


def hull(points):
    """Convex hull (monotone chain) of an (n, 2) integer array."""
    pts = sorted(set(map(tuple, points)))
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0: lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0: upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1], dtype=float)


def area_centroid(p):
    x, y = p[:, 0], p[:, 1]
    xn, yn = np.roll(x, -1), np.roll(y, -1)
    c = x * yn - xn * y
    a = c.sum() / 2
    return a, np.array([((x + xn) * c).sum() / (6 * a), ((y + yn) * c).sum() / (6 * a)])


def simplify(p, n):
    """Drop, one at a time, the corner whose removal changes the shape least."""
    p = list(map(tuple, p))
    while len(p) > n:
        best, at = None, 0
        for i in range(len(p)):
            a, b, c = p[i - 1], p[i], p[(i + 1) % len(p)]
            t = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
            if best is None or t < best: best, at = t, i
        p.pop(at)
    return np.array(p)


def blur(a, sigma):
    """Gaussian blur of a float array, one axis at a time."""
    n = int(sigma * 3) + 1
    k = np.exp(-0.5 * (np.arange(-n, n + 1) / sigma) ** 2); k /= k.sum()
    a = np.pad(a, n)
    a = np.array([np.convolve(row, k, 'same') for row in a])
    a = np.array([np.convolve(col, k, 'same') for col in a.T]).T
    return a[n:-n, n:-n]


def thicken(im, t):
    """Grows the drawing outwards by t pixels of black, following its shape."""
    pad = int(t) + 3                                  # room for the new outline if the drawing is near the border
    im = np.pad(im, ((pad, pad), (pad, pad), (0, 0)))
    alpha = im[..., 3] / 255.0
    # Blurring a filled shape with sigma = t leaves about 0.159 exactly t pixels outside its edge.
    soft = blur((alpha > 0.5).astype(float), t)
    ring = np.clip((soft - 0.1587) * (t / 0.242) + 0.5, 0, 1)
    out = im.astype(float)
    out[..., :3] *= alpha[..., None]                 # the drawing, over black
    out[..., 3] = np.maximum(alpha, ring) * 255
    return out.round().astype('uint8')


def load(folder):
    """Returns the drawings that exist and, for each of the four faces, which drawing it uses."""
    names, imgs, use = [], [], []
    cfg_path = os.path.join(folder, 'art.json')
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
    for face in FACES:
        for name in [face] + FALLBACK.get(face, []):
            path = os.path.join(folder, name + '.png')
            if not os.path.exists(path): continue
            if name not in names:
                im = np.array(Image.open(path).convert('RGBA'))
                im[..., 3][im[..., 3] >= 245] = 255      # "almost solid" left by some drawing tools is solid
                # A faint glow around the drawing would become part of the food: keep only what is
                # solid, plus the few soft pixels that smooth its edge.
                near = Image.fromarray(((im[..., 3] > 127) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(5))
                im[..., 3][np.array(near) == 0] = 0
                if cfg.get('outline'): im = thicken(im, float(cfg['outline']))
                names.append(name); imgs.append(Image.fromarray(im, 'RGBA'))
            use.append(names.index(name))
            break
        else:
            sys.exit(folder + ': open.png is missing')
    if len({im.size for im in imgs}) != 1: sys.exit(folder + ': the drawings are not all the same size')
    return names, imgs, use


def build(level, folder):
    names, imgs, use = load(folder)
    alpha = np.max([np.array(im)[..., 3] for im in imgs], axis=0)
    solid = alpha > 127
    if not solid.any(): sys.exit(folder + ': the drawing is empty')
    if solid[0].any() or solid[-1].any() or solid[:, 0].any() or solid[:, -1].any():
        print('  note: the drawing touches the edge of the picture; it may be cut off there')

    # Outline: the hull of the solid part, taken at the pixel corners.
    edge = solid & ~(np.roll(solid, 1, 0) & np.roll(solid, -1, 0) & np.roll(solid, 1, 1) & np.roll(solid, -1, 1))
    ys, xs = np.nonzero(edge)
    corners = np.concatenate([np.stack([xs + dx, ys + dy], 1) for dx in (0, 1) for dy in (0, 1)])
    full = hull(corners)
    area_full, centre = area_centroid(full)
    out = simplify(full, OUTLINE_POINTS)
    area, _ = area_centroid(out)
    if area < 0: out = out[::-1]; area = -area
    cover = area / abs(area_full)
    # Cutting corners made it a little smaller: grow it back to the area of the full outline.
    out = centre + (out - centre) * (abs(area_full) / area) ** 0.5
    unit = abs(area_full) ** 0.5                 # one unit = side of a square with the outline's area
    start = int(np.argmin(out[:, 1] * 3 + out[:, 0]))   # start near the top, like the built-in shapes
    out = np.roll(out, -start, axis=0)

    # Square cut around the centre that holds every painted pixel of every face.
    ys, xs = np.nonzero(alpha > 0)
    half = max(np.abs(xs + 0.5 - centre[0]).max(), np.abs(ys + 0.5 - centre[1]).max()) + 3
    size = int(min(640, 192 + 48 * level))
    box = [int(round(centre[0] - half)), int(round(centre[1] - half))]
    side = int(round(half * 2))
    sheet = Image.new('RGBA', (size * len(imgs), size), (0, 0, 0, 0))
    for i, im in enumerate(imgs):
        cut = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        cut.paste(im, (-box[0], -box[1]))
        # Shrink with the colours weighted by their opacity, so no dark rim appears on the edge.
        small = cut.convert('RGBa').resize((size, size), Image.LANCZOS).convert('RGBA')
        sheet.paste(small, (i * size, 0))
    os.makedirs(OUT, exist_ok=True)
    target = os.path.join(OUT, '%d.webp' % level)
    sheet.save(target, 'WEBP', quality=92, alpha_quality=100, method=6, exact=False)
    print('  %s  %s, %dx%d each, %d KB' % (os.path.relpath(target, ROOT), ' + '.join(names), size, size, os.path.getsize(target) // 1024))
    print('  outline %d points, %.1f%% of the full outline before growing it back' % (len(out), 100 * cover))
    return {
        'outline': [[round(float(x - centre[0]) / unit, 5), round(float(y - centre[1]) / unit, 5)] for x, y in out],
        'half': round(side / 2 / unit, 5),       # half side of the square picture
        'faces': use                             # for open, half, closed, wow: which picture in the row
    }


def main():
    art = {}
    for name in sorted(os.listdir(SRC), key=lambda s: (len(s), s)):
        folder = os.path.join(SRC, name)
        if not (os.path.isdir(folder) and name.isdigit()): continue
        print('level', name)
        art[name] = build(int(name), folder)
    with open(os.path.join(ROOT, 'scripts', 'art.json'), 'w') as fh:
        json.dump(art, fh, indent=1)
        fh.write('\n')
    print('scripts/art.json written for levels', ', '.join(art) or '(none)')


if __name__ == '__main__':
    main()
