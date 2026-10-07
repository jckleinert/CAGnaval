#!/usr/bin/env python3
"""
Turns the drawings in art/foods/<level>/ into what the game uses.

For each level folder it reads up to four drawings of the same food, all the
same size and with the food in the same place:
    open.png    normal face (the only one that is required)
    half.png    eyes half closed      (optional, falls back to closed/open)
    closed.png  eyes closed           (optional, falls back to open)
    wow.png     surprised face        (optional, falls back to open)

Every food ends up with a dark outline of the same thickness in the jar (OUTLINE, in game
units). A small food drawn with the same line as a big one would otherwise almost lose it once
it is shrunk to its size. The script measures the outline of each drawing and adds what is
missing around it, outwards; it never thins one. A folder may hold art.json with
{"outline": false} to leave that food's outline as drawn.

A food can also have a golden version (the golden food of a run). It is not drawn apart: it is
the same drawing, all its faces, painted over with the colours given under "gold" in art.json,
so it blinks the same way and fits the same outline to the pixel. gold-reference.png in the
folder is the drawing those colours were taken from; the script does not read it.

and writes:
    web/img/foods/<level>.webp        the different faces side by side, cut square
    web/img/foods/<level>-gold.webp   the same in gold, for a food that has a golden version
    scripts/art.json             the outline of each drawing, for gen-foods.js

Needs Pillow and numpy. Run it, then run: node scripts/gen-foods.js
"""
import json
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'art', 'foods')
OUT = os.path.join(ROOT, 'web', 'img', 'foods')
FACES = ['open', 'half', 'closed', 'wow']
FALLBACK = {'half': ['closed', 'open'], 'closed': ['open'], 'wow': ['open']}
OUTLINE_POINTS = 16
OUTLINE = 1.05         # thickness of the dark outline in the jar, in game units (0 = leave as drawn)


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


def golden(im, cfg):
    """The drawing in gold. What is pale and has no colour of its own (the body, its shadows, the
    lines on it) takes the gold ramp by how light it is; the pink of the mouth becomes the gold
    version's pink; dark things (outline, seaweed) and the whites of the eyes stay as they are."""
    rgb = im[..., :3].astype(float)
    hi, lo = rgb.max(axis=2), rgb.min(axis=2)
    base = float(max(cfg['from']['base']))
    stops = [(0.0, (0, 0, 0)), (0.55, cfg['to']['deep']), (0.86, cfg['to']['shade']), (1.0, cfg['to']['base'])]
    v = np.clip(hi / base, 0, 1)
    ramp = np.stack([np.interp(v, [s[0] for s in stops], [s[1][c] for s in stops]) for c in range(3)], axis=2)
    out = ramp
    dark = hi <= 75                                              # outline, pupils, seaweed
    out[dark] = rgb[dark]
    pink = (rgb[..., 0] - rgb[..., 1] > 50) & (rgb[..., 0] > 120)
    scale = np.array(cfg['to']['lips'], dtype=float) / np.array(cfg['from']['lips'], dtype=float)
    out[pink] = np.clip(rgb[pink] * scale, 0, 255)
    # The whites of the eyes are the only pure white; keep them and their soft edge against the lines.
    white = Image.fromarray(((lo >= 249) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(7))
    eye = (np.array(white) > 0) & ~pink
    out[eye] = rgb[eye]
    res = im.copy()
    res[..., :3] = out.round().astype('uint8')
    return res


def load(folder):
    """Returns the drawings that exist and, for each of the four faces, which drawing it uses."""
    names, imgs, use = [], [], []
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
                names.append(name); imgs.append(im)
            use.append(names.index(name))
            break
        else:
            sys.exit(folder + ': open.png is missing')
    if len({im.shape for im in imgs}) != 1: sys.exit(folder + ': the drawings are not all the same size')
    return names, imgs, use


def shape(alpha):
    """Outline of the solid part: its full hull, its area and centre, and the hull cut down to a few points."""
    solid = alpha > 127
    edge = solid & ~(np.roll(solid, 1, 0) & np.roll(solid, -1, 0) & np.roll(solid, 1, 1) & np.roll(solid, -1, 1))
    ys, xs = np.nonzero(edge)
    corners = np.concatenate([np.stack([xs + dx, ys + dy], 1) for dx in (0, 1) for dy in (0, 1)])   # pixel corners
    full = hull(corners)
    area_full, centre = area_centroid(full)
    out = simplify(full, OUTLINE_POINTS)
    area, _ = area_centroid(out)
    if area < 0: out = out[::-1]; area = -area
    return abs(area_full), centre, out, area / abs(area_full)


def line_width(im, out, centre):
    """Thickness in pixels of the dark line around the drawing: walk in from outside at many points
    of the outline, straight across it, and count how long the pixels stay dark. Takes the middle
    value, so a dark part of the drawing that reaches the edge (the onigiri's seaweed) does not count."""
    h, w = im.shape[:2]
    dark = (im[..., :3].max(axis=2) <= 80) & (im[..., 3] > 127)
    solid = im[..., 3] > 127
    found = []
    for i in range(len(out)):
        a, b = out[i], out[(i + 1) % len(out)]
        n = np.array([b[1] - a[1], a[0] - b[0]], dtype=float); n /= np.hypot(*n) or 1
        if np.dot(centre - (a + b) / 2, n) < 0: n = -n            # pointing inwards
        for f in np.linspace(0.1, 0.9, 9):
            p = a + (b - a) * f - n * 8
            first = None
            for step in range(0, 400):
                x, y = int(p[0] + n[0] * step * 0.5), int(p[1] + n[1] * step * 0.5)
                if not (0 <= x < w and 0 <= y < h): continue
                if first is None:
                    if solid[y, x]: first = step
                elif not dark[y, x]:
                    found.append((step - first) * 0.5); break
    return float(np.median(found)) if found else 0.0


def build(level, folder, radius):
    """radius: the radius, in game units, of a circle with the area this food has in the game."""
    names, imgs, use = load(folder)
    cfg_path = os.path.join(folder, 'art.json')
    cfg = json.load(open(cfg_path)) if os.path.exists(cfg_path) else {}
    alpha = np.max([im[..., 3] for im in imgs], axis=0)
    if not (alpha > 127).any(): sys.exit(folder + ': the drawing is empty')
    area_full, centre, out, cover = shape(alpha)
    gold = [golden(im, cfg['gold']) for im in imgs] if cfg.get('gold') else []

    # Outline thickness. In the jar the drawing is scaled so that its area matches the food's, so
    # one game unit is r_px / radius pixels. Adding e pixels all around also makes it e bigger:
    # (line + e) / (r_px + e) = OUTLINE / radius.
    r_px = math.sqrt(area_full / math.pi)
    line = line_width(imgs[0], out, centre)
    extra = (OUTLINE * r_px - line * radius) / (radius - OUTLINE) if OUTLINE and cfg.get('outline', True) else 0
    print('  outline as drawn: %.1f px = %.2f game units%s' % (line, line * radius / r_px, ', adding %.1f px' % extra if extra >= 1 else ''))
    if extra >= 1:
        imgs = [thicken(im, extra) for im in imgs]
        gold = [thicken(im, extra) for im in gold]
        alpha = np.max([im[..., 3] for im in imgs], axis=0)
        area_full, centre, out, cover = shape(alpha)
    solid = alpha > 127
    if solid[0].any() or solid[-1].any() or solid[:, 0].any() or solid[:, -1].any():
        print('  note: the drawing touches the edge of the picture; it may be cut off there')
    imgs = [Image.fromarray(im, 'RGBA') for im in imgs]
    gold = [Image.fromarray(im, 'RGBA') for im in gold]

    # Cutting corners made the outline a little smaller: grow it back to the area of the full one.
    out = centre + (out - centre) * (1 / cover) ** 0.5
    unit = area_full ** 0.5                      # one unit = side of a square with the outline's area
    start = int(np.argmin(out[:, 1] * 3 + out[:, 0]))   # start near the top, like the built-in shapes
    out = np.roll(out, -start, axis=0)

    # Square cut around the centre that holds every painted pixel of every face.
    ys, xs = np.nonzero(alpha > 0)
    half = max(np.abs(xs + 0.5 - centre[0]).max(), np.abs(ys + 0.5 - centre[1]).max()) + 3
    size = int(min(640, 192 + 48 * level))
    box = [int(round(centre[0] - half)), int(round(centre[1] - half))]
    side = int(round(half * 2))
    os.makedirs(OUT, exist_ok=True)
    for frames, suffix in ((imgs, ''), (gold, '-gold')):
        if not frames: continue
        sheet = Image.new('RGBA', (size * len(frames), size), (0, 0, 0, 0))
        for i, im in enumerate(frames):
            cut = Image.new('RGBA', (side, side), (0, 0, 0, 0))
            cut.paste(im, (-box[0], -box[1]))
            # Shrink with the colours weighted by their opacity, so no dark rim appears on the edge.
            small = cut.convert('RGBa').resize((size, size), Image.LANCZOS).convert('RGBA')
            sheet.paste(small, (i * size, 0))
        target = os.path.join(OUT, '%d%s.webp' % (level, suffix))
        sheet.save(target, 'WEBP', quality=92, alpha_quality=100, method=6, exact=False)
        print('  %s  %s, %dx%d each, %d KB' % (os.path.relpath(target, ROOT), ' + '.join(names), size, size, os.path.getsize(target) // 1024))
    print('  outline %d points, %.1f%% of the full outline before growing it back' % (len(out), 100 * cover))
    return {
        'outline': [[round(float(x - centre[0]) / unit, 5), round(float(y - centre[1]) / unit, 5)] for x, y in out],
        'half': round(side / 2 / unit, 5),       # half side of the square picture
        'faces': use,                            # for open, half, closed, wow: which picture in the row
        'gold': bool(gold)                       # it has a golden version of its own
    }


def main():
    # How big each food is in the game, from the food table.
    radii = json.loads(subprocess.check_output(['node', os.path.join(ROOT, 'scripts', 'gen-foods.js'), '--sizes']))
    art = {}
    for name in sorted(os.listdir(SRC), key=lambda s: (len(s), s)):
        folder = os.path.join(SRC, name)
        if not (os.path.isdir(folder) and name.isdigit()): continue
        print('level', name)
        art[name] = build(int(name), folder, radii[int(name)])
    with open(os.path.join(ROOT, 'scripts', 'art.json'), 'w') as fh:
        json.dump(art, fh, indent=1)
        fh.write('\n')
    print('scripts/art.json written for levels', ', '.join(art) or '(none)')


if __name__ == '__main__':
    main()
