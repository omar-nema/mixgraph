// Generate 40 pre-rasterized gradient images from the gradient palettes.
// Run: node scripts/gen_gradients.mjs

import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

const gradientPalettes = [
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
];

const SIZE = 120;
const NUM_IMAGES = 40;

function hexToRgba(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

for (let n = 0; n < NUM_IMAGES; n++) {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  // Use n as the hash to pick palette and positions (same logic as generateGradient)
  const h = n * 7919; // spread across palettes using a prime
  const palette = gradientPalettes[n % gradientPalettes.length];

  const positions = [
    [h % 40 + 10, h % 30 + 10],
    [70 + (h >> 4) % 20, h % 25 + 5],
    [(h >> 8) % 30 + 10, 70 + (h >> 2) % 20],
    [60 + (h >> 6) % 30, 60 + (h >> 3) % 30],
    [40 + (h >> 5) % 20, 40 + (h >> 7) % 20],
  ];

  // Fill base color
  const [br, bg, bb] = hexToRgba(palette[1]);
  ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Draw radial gradients (reverse order so first layer is on top)
  for (let i = palette.length - 1; i >= 0; i--) {
    const [x, y] = positions[i % positions.length];
    const size = 50 + ((h >> (i * 3)) % 40);
    const cx = (x / 100) * SIZE;
    const cy = (y / 100) * SIZE;
    const radius = (size / 100) * SIZE;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    const [cr, cg, cb] = hexToRgba(palette[i]);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }

  const buf = canvas.toBuffer('image/jpeg', { quality: 0.85 });
  writeFileSync(`gradients/${n}.jpg`, buf);
}

console.log(`Generated ${NUM_IMAGES} gradient images in gradients/`);
