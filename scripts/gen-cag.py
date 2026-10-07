#!/usr/bin/env python3
"""
Turns the drawings in art/cag/ into the character that leans over the jar.

Reads:
    normal.png, closed.png, wide.png   the bust with three faces (same size, same place)
    cag.json                            where things are in those drawings (pixels of normal.png):
        eyes         [cx, cy, rx, ry] of each eye socket
        skin         a spot of plain skin, to match the colour between drawings
        base         the row where the bust is cut flat; below it there are only loose bits
        body_width   width of the bust in the game, in game units

Writes:
    web/img/cag/body.webp   the three faces side by side
    web/cag-art.js          its sizes, for the game page

The three busts come from separate drawings, so their lines never match to the pixel and the
whole figure would twitch on every blink. To avoid it only the eyes are taken from closed.png
and wide.png; everything else is normal.png in all three.

Needs Pillow and numpy. Uses the outline tools of gen-art.py.
"""
import importlib.util
import json
import os

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
SRC = os.path.join(ROOT, 'art', 'cag')
OUT = os.path.join(ROOT, 'web', 'img', 'cag')
spec = importlib.util.spec_from_file_location('gen_art', os.path.join(HERE, 'gen-art.py'))
art = importlib.util.module_from_spec(spec); spec.loader.exec_module(art)
BODY_PX = 560                        # width of each face in the picture the game loads


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
        im, moved = with_eyes_of(normal, load(name), cfg['eyes'], cfg['skin'])
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
    body = {'w': BODY_PX, 'h': bh_px, 'faces': len(frames)}
    meta = {'bodyWidth': cfg['body_width'], 'body': body}
    with open(os.path.join(ROOT, 'web', 'cag-art.js'), 'w') as fh:
        fh.write('/* GENERATED by scripts/gen-cag.py. Do not edit by hand. Sizes of the character\'s picture. */\n')
        fh.write('window.CAG_PUPPET = ' + json.dumps(meta, indent=1) + ';\n')
    print(json.dumps(meta))
    print('body.webp', os.path.getsize(os.path.join(OUT, 'body.webp')) // 1024, 'KB')


if __name__ == '__main__':
    main()
