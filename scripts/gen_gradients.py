"""Generate 40 pre-rasterized gradient images from the gradient palettes."""
import math, random
from PIL import Image, ImageFilter
import numpy as np

PALETTES = [
    ['#EB4679','#051681','#EE7F7D','#265BC9','#C25EA5','#7961D3'],
    ['#FF6B6B','#4ECDC4','#2C3E50','#F39C12','#8E44AD'],
    ['#E44D90','#2B86C5','#784BA0','#F5AF19','#C850C0'],
    ['#0F2027','#2C5364','#203A43','#E8775F','#F2A65A'],
    ['#DA4453','#89216B','#2980B9','#6DD5FA','#FF512F'],
    ['#A770EF','#CF8BF3','#FDB99B','#5B86E5','#36D1DC'],
    ['#654EA3','#EAAFC8','#F093FB','#F5576C','#4FACFE'],
    ['#1A2980','#26D0CE','#4776E6','#8E54E9','#00C9FF'],
    ['#EC6F66','#F3A183','#2C3E50','#3498DB','#9B59B6'],
    ['#C33764','#1D2671','#FDC830','#F37335','#6441A5'],
    ['#E65C00','#F9D423','#2B5876','#4E4376','#C94B4B'],
    ['#B24592','#F15F79','#00B4DB','#0083B0','#8360C3'],
]

# Render at 2x then downscale for smoother gradients
RENDER_SIZE = 240
OUTPUT_SIZE = 120
NUM = 40

def hex_to_rgb(h):
    return (int(h[1:3],16), int(h[3:5],16), int(h[5:7],16))

for n in range(NUM):
    random.seed(n * 7919)
    img = Image.new('RGB', (RENDER_SIZE, RENDER_SIZE))
    pixels = img.load()

    h = n * 7919
    palette = PALETTES[n % len(PALETTES)]
    positions = [
        (h % 40 + 10, h % 30 + 10),
        (70 + (h >> 4) % 20, h % 25 + 5),
        ((h >> 8) % 30 + 10, 70 + (h >> 2) % 20),
        (60 + (h >> 6) % 30, 60 + (h >> 3) % 30),
        (40 + (h >> 5) % 20, 40 + (h >> 7) % 20),
    ]

    base = hex_to_rgb(palette[1])

    # Render gradient at 2x resolution
    for py in range(RENDER_SIZE):
        for px in range(RENDER_SIZE):
            r, g, b = base
            for i in range(len(palette) - 1, -1, -1):
                x_pct, y_pct = positions[i % len(positions)]
                size = 50 + ((h >> (i * 3)) % 40)
                cx = (x_pct / 100) * RENDER_SIZE
                cy = (y_pct / 100) * RENDER_SIZE
                radius = (size / 100) * RENDER_SIZE

                dist = math.sqrt((px - cx)**2 + (py - cy)**2)
                if dist < radius:
                    alpha = 1.0 - (dist / radius)
                    cr, cg, cb = hex_to_rgb(palette[i])
                    r = int(r * (1 - alpha) + cr * alpha)
                    g = int(g * (1 - alpha) + cg * alpha)
                    b = int(b * (1 - alpha) + cb * alpha)

            pixels[px, py] = (r, g, b)

    # Slight blur for smoother blending
    img = img.filter(ImageFilter.GaussianBlur(radius=2.5))

    # Warp/distort: shift pixels with a subtle sine-based displacement
    arr = np.array(img, dtype=np.float64)
    result = np.zeros_like(arr)
    for py in range(RENDER_SIZE):
        for px in range(RENDER_SIZE):
            dx = math.sin(py / RENDER_SIZE * 4 * math.pi + n) * 3.5
            dy = math.cos(px / RENDER_SIZE * 3 * math.pi + n * 0.7) * 3.5
            sx = min(max(int(px + dx), 0), RENDER_SIZE - 1)
            sy = min(max(int(py + dy), 0), RENDER_SIZE - 1)
            result[py, px] = arr[sy, sx]
    img = Image.fromarray(result.astype(np.uint8))

    # Add film grain
    arr = np.array(img, dtype=np.int16)
    grain = np.random.RandomState(n).randint(-18, 19, arr.shape, dtype=np.int16)
    arr = np.clip(arr + grain, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)

    # Downscale to output size
    img = img.resize((OUTPUT_SIZE, OUTPUT_SIZE), Image.LANCZOS)

    img.save(f'gradients/{n}.jpg', 'JPEG', quality=85)
    print(f'  {n}.jpg')

print(f'Generated {NUM} gradient images')
