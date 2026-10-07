#!/usr/bin/env python3
"""
Turns the drawings in art/cag/ into the character that drops the foods.

Reads:
    normal.png, closed.png, wide.png   the bust with three faces (same size, same place)
    hand.png                            one open hand: fingers up, thumb down, opening to the
                                        right, cut flat at the wrist
    cag.json                            where things are in those drawings (pixels of normal.png):
        eyes         [cx, cy, rx, ry] of each eye socket
        roots        where each arm starts, inside the body, left then right
        base         the row where the bust is cut flat; below it there are only loose bits
        body_width   width of the bust in the game, in game units
        hand_height  height of a hand in the game, in game units
        hand_tilt    how much a hand leans in over what it holds, in degrees

Writes:
    web/img/cag/body.webp   the three faces side by side
    web/img/cag/hand.webp   the left hand of the screen (thumb up), ready to mirror for the right
    web/cag-art.js          sizes and anchor points, for the game page

The three busts come from separate drawings, so their lines never match to the pixel and the
whole figure would twitch on every blink. To avoid it only the eyes are taken from closed.png
and wide.png; everything else is normal.png in all three.

Needs Pillow and numpy. Uses the outline tools of gen-art.py.
"""
import importlib.util
import json
import math
import os

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
SRC = os.path.join(ROOT, 'art', 'cag')
OUT = os.path.join(ROOT, 'web', 'img', 'cag')
spec = importlib.util.spec_from_file_location('gen_art', os.path.join(HERE, 'gen-art.py'))
art = importlib.util.module_from_spec(spec); spec.loader.exec_module(art)
BODY_PX, HAND_PX = 560, 280          # size of the pictures the game loads


def load(name):
    return np.array(Image.open(os.path.join(SRC, name + '.png')).convert('RGBA'))


def shift_between(a, b, eyes):
    """How many pixels b is moved against a, looking at everything except the eyes."""
    def gray(im):
        g = im[..., :3].mean(axis=2) * (im[..., 3] / 255.0) + 128 * (1 - im[..., 3] / 255.0)
        for cx, cy, rx, ry in eyes: g[int(cy - ry):int(cy + ry), int(cx - rx):int(cx + rx)] = 128
        return g - g.mean()
    r = np.fft.irfft2(np.fft.rfft2(gray(a)) * np.conj(np.fft.rfft2(gray(b))), s=a.shape[:2])
    y, x = np.unravel_index(np.argmax(r), r.shape)
    return (x - a.shape[1] if x > a.shape[1] // 2 else x), (y - a.shape[0] if y > a.shape[0] // 2 else y)


def skin_of(im, at):
    x, y = at
    return np.median(im[y - 12:y + 12, x - 12:x + 12, :3].reshape(-1, 3), axis=0)


def with_eyes_of(base, other, eyes, skin_at):
    """base with only the eye sockets of other, moved into place and matched in skin colour."""
    dx, dy = shift_between(base, other, eyes)
    moved = np.roll(np.roll(other, dy, axis=0), dx, axis=1).astype(float)
    delta = skin_of(base, skin_at) - skin_of(moved.astype('uint8'), skin_at)
    near = np.abs(moved[..., :3] - skin_of(moved.astype('uint8'), skin_at)).sum(axis=2) < 60
    moved[..., :3][near] += delta
    h, w = base.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    mask = np.zeros((h, w))
    for cx, cy, rx, ry in eyes:
        d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
        mask = np.maximum(mask, np.clip((1 - d) * min(rx, ry) / 10.0, 0, 1))     # soft edge, about 10 px
    out = base.astype(float)
    out[..., :3] = out[..., :3] * (1 - mask[..., None]) + moved[..., :3] * mask[..., None]
    return out.clip(0, 255).round().astype('uint8'), (dx, dy)


def clean(im):
    im = im.copy()
    im[..., 3][im[..., 3] >= 245] = 255
    near = Image.fromarray(((im[..., 3] > 127) * 255).astype('uint8')).filter(ImageFilter.MaxFilter(5))
    im[..., 3][np.array(near) == 0] = 0
    return im


def outline_px(im):
    alpha = im[..., 3]
    area, centre, out, cover = art.shape(alpha)
    return art.line_width(im, out, centre)


def shrink(im, box, size):
    cut = Image.fromarray(im, 'RGBA').crop(box)
    return cut.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA')


def main():
    cfg = json.load(open(os.path.join(SRC, 'cag.json')))
    unit_line = art.OUTLINE                          # outline thickness of the foods, in game units

    # ---- the bust ----
    normal = load('normal')
    frames = [normal]
    for name in ('closed', 'wide'):
        im, moved = with_eyes_of(normal, load(name), cfg['eyes'], cfg['roots'][0])
        print('%s: eyes taken from it (it was off by %d, %d px)' % (name, moved[0], moved[1]))
        frames.append(im)
    frames = [clean(f) for f in frames]
    for f in frames: f[cfg['base']:, :, 3] = 0       # flat cut where it rests on the jar
    ys, xs = np.nonzero(frames[0][..., 3] > 127)
    width_px = xs.max() - xs.min() + 1
    px_per_unit = width_px / cfg['body_width']
    line = outline_px(frames[0])
    extra = unit_line * px_per_unit - line
    print('bust: %d px wide, outline %.1f px = %.2f game units%s' % (width_px, line, line / px_per_unit, ', adding %.1f px' % extra if extra >= 1 else ''))
    pad = 0
    if extra >= 1:
        pad = int(extra) + 3
        frames = [art.thicken(f, extra) for f in frames]
    al = frames[0][..., 3]
    ys, xs = np.nonzero(al > 0)
    x0, x1, y0, y1 = xs.min() - 2, xs.max() + 3, ys.min() - 2, ys.max() + 1
    bw, bh = x1 - x0, y1 - y0
    bh_px = int(round(BODY_PX * bh / bw))
    sheet = Image.new('RGBA', (BODY_PX * len(frames), bh_px), (0, 0, 0, 0))
    for i, f in enumerate(frames): sheet.paste(shrink(f, (x0, y0, x1, y1), (BODY_PX, bh_px)), (i * BODY_PX, 0))
    os.makedirs(OUT, exist_ok=True)
    sheet.save(os.path.join(OUT, 'body.webp'), 'WEBP', quality=92, alpha_quality=100, method=6)
    skin = skin_of(normal, cfg['roots'][0])
    base_y = cfg['base'] + pad                       # bottom of the body's blue, in the padded picture
    centre_x = (x0 + x1) / 2
    body = {
        'w': BODY_PX, 'h': bh_px, 'faces': len(frames),
        # arm roots: sideways from the centre and up from the bottom of the picture, as fractions of its width
        'roots': [[round((rx + pad - centre_x) / bw, 4), round((y1 - (ry + pad)) / bw, 4)] for rx, ry in cfg['roots']],
        'base': round((y1 - base_y) / bw, 4),        # the bust's own bottom edge, above the picture's bottom
        'skin': '#%02x%02x%02x' % tuple(int(round(v)) for v in skin)
    }

    # ---- the hand ----
    hand = clean(load('hand'))
    solid = hand[..., 3] > 127
    blue = solid & (np.abs(hand[..., :3].astype(float) - skin_of(hand, (500, 600))).sum(axis=2) < 90)
    # Same skin as the body, so the arm drawn between them matches both.
    hand[..., :3][blue] = np.clip(hand[..., :3][blue] + (skin - skin_of(hand, (500, 600))), 0, 255).round().astype('uint8')
    # The wrist is the only stretch of the edge with no dark line: skin right against nothing.
    inner = np.array(Image.fromarray((solid * 255).astype('uint8')).filter(ImageFilter.MinFilter(5))) > 0
    cut = solid & ~inner & blue
    ys, xs = np.nonzero(cut)
    keep = xs < np.percentile(xs, 50) + 120          # the wrist is one clump; drop stray specks elsewhere
    pts = np.stack([xs[keep], ys[keep]], 1).astype(float)
    wrist = pts.mean(axis=0)
    along = np.linalg.svd(pts - wrist)[2][0]
    length = float(np.ptp((pts - wrist) @ along))
    away = np.array([along[1], -along[0]])
    hy, hx = np.nonzero(solid)
    if np.dot(away, np.array([hx.mean(), hy.mean()]) - wrist) > 0: away = -away
    # The grip: the innermost point of the opening, halfway between fingers and thumb.
    rows = [y for y in range(hy.min(), hy.max()) if solid[y].any()]
    mid = [y for y in rows if np.nonzero(np.diff(np.nonzero(solid[y])[0]) > 5)[0].size == 0 and np.nonzero(solid[y])[0].max() < hx.max() - 0.25 * np.ptp(hx)]
    gy = int(np.median(mid)); gx = int(np.nonzero(solid[gy])[0].max())
    hand_px_per_unit = (np.ptp(hy) + 1) / cfg['hand_height']
    hline = outline_px(hand)
    hextra = unit_line * hand_px_per_unit - hline
    print('hand: %d px tall, outline %.1f px = %.2f game units%s' % (np.ptp(hy) + 1, hline, hline / hand_px_per_unit, ', adding %.1f px' % hextra if hextra >= 1 else ''))
    hpad = 0
    if hextra >= 1:
        hpad = int(hextra) + 3
        thick = art.thicken(hand, hextra)
        # ...but not across the wrist: nothing may be added beyond the cut, where the arm arrives.
        h2, w2 = thick.shape[:2]
        yy, xx = np.mgrid[0:h2, 0:w2]
        beyond = ((xx - (wrist[0] + hpad)) * away[0] + (yy - (wrist[1] + hpad)) * away[1]) > -1.0
        was = np.pad(hand[..., 3], hpad)
        added = (thick[..., 3].astype(int) - was) > 0
        thick[..., 3][beyond & added] = was[beyond & added]
        hand = thick
    wrist += hpad; gx += hpad; gy += hpad
    ys, xs = np.nonzero(hand[..., 3] > 0)
    x0, x1, y0, y1 = xs.min() - 2, xs.max() + 3, ys.min() - 2, ys.max() + 3
    hw, hh = x1 - x0, y1 - y0
    hw_px = int(round(HAND_PX * hw / hh))
    # Stored upside down: with the thumb up it is the hand that holds something from its left side,
    # with the arm coming from above.
    small = shrink(hand, (x0, y0, x1, y1), (hw_px, HAND_PX)).transpose(Image.FLIP_TOP_BOTTOM)
    small.save(os.path.join(OUT, 'hand.webp'), 'WEBP', quality=92, alpha_quality=100, method=6)
    flip = lambda p: [(p[0] - x0) / hh, (y1 - p[1]) / hh]          # into the stored picture, as fractions of its height
    hand_meta = {
        'w': hw_px, 'h': HAND_PX,
        'grip': [round(v, 4) for v in flip((gx, gy))],
        'wrist': [round(v, 4) for v in flip(wrist)],
        'away': [round(float(away[0]), 4), round(float(-away[1]), 4)],    # direction the arm leaves the hand
        'arm': round(length / hh, 4)                                      # arm thickness
    }
    meta = {'bodyWidth': cfg['body_width'], 'handHeight': cfg['hand_height'], 'handTilt': cfg['hand_tilt'], 'outline': unit_line, 'body': body, 'hand': hand_meta}
    with open(os.path.join(ROOT, 'web', 'cag-art.js'), 'w') as fh:
        fh.write('/* GENERATED by scripts/gen-cag.py. Do not edit by hand. Sizes and anchor points of the character. */\n')
        fh.write('window.CAG_PUPPET = ' + json.dumps(meta, indent=1) + ';\n')
    print(json.dumps(meta))
    for n in ('body.webp', 'hand.webp'): print(n, os.path.getsize(os.path.join(OUT, n)) // 1024, 'KB')


if __name__ == '__main__':
    main()
