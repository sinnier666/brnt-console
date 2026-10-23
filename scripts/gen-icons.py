"""Generate BRNT Cookie Bridge icons (dark rounded square + emerald cookie with chips).

Pure-python PNG writer (zlib + struct), supersampled 4x for smooth edges.
Outputs icon128.png, icon48.png, icon16.png into the extension icons/ dir.
"""
import struct
import zlib
import math
import os

OUT_DIR = "/home/z/my-project/download/brnt-cookie-bridge/icons"

BG = (11, 15, 20)        # #0b0f14
COOKIE = (16, 185, 129)  # #10b981 emerald
CHIP = (6, 78, 59)       # dark emerald chip
CHIP2 = (5, 46, 28)      # darker chip

# chip positions relative to cookie center, in units of cookie radius (dx, dy, r)
CHIPS = [
    (-0.32, -0.30, 0.13),
    (0.38, -0.10, 0.11),
    (-0.05, 0.28, 0.12),
    (0.28, 0.45, 0.09),
    (-0.45, 0.15, 0.09),
    (0.05, -0.52, 0.08),
]


def draw(w, ss=4):
    """Draw at width w with ss x supersampling; return rows of RGBA bytes."""
    n = w * ss
    cx = 0.5 * n
    cy = 0.52 * n
    r_cookie = 0.30 * n
    corner = 0.22 * n
    half = n / 2.0

    def inside_rounded(x, y):
        # rounded square 0..n
        m = 0.02 * n  # outer margin
        if x < m or y < m or x > n - m or y > n - m:
            return False
        qx = max(corner + m - x, 0, x - (n - m - corner))
        qy = max(corner + m - y, 0, y - (n - m - corner))
        return qx * qx + qy * qy <= corner * corner

    def sample(x, y):
        if not inside_rounded(x, y):
            return (0, 0, 0, 0)
        d = math.hypot(x - cx, y - cy)
        if d > r_cookie:
            return BG + (255,)
        # chips
        for dx, dy, cr in CHIPS:
            ccx = cx + dx * r_cookie
            ccy = cy + dy * r_cookie
            crad = cr * r_cookie
            if math.hypot(x - ccx, y - ccy) <= crad:
                return CHIP2 + (255,)
        return COOKIE + (255,)

    rows = []
    for y in range(w):
        row = bytearray()
        for x in range(w):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    px = sample(x * ss + sx + 0.5, y * ss + sy + 0.5)
                    r += px[0]
                    g += px[1]
                    b += px[2]
                    a += px[3]
            cnt = ss * ss
            row += bytes((r // cnt, g // cnt, b // cnt, a // cnt))
        rows.append(bytes(row))
    return rows


def write_png(path, w, h, rows):
    def chunk(t, d):
        return (
            struct.pack(">I", len(d))
            + t
            + d
            + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        )

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    idat = zlib.compress(b"".join(b"\x00" + r for r in rows), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (128, 48, 16):
        rows = draw(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, size, rows)
        print(f"wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
