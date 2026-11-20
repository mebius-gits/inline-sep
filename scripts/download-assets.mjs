import { mkdir, writeFile } from 'node:fs/promises';
import { seedMenu, heroSource } from '../lib/menu.js';
await mkdir('public/assets', { recursive: true });
const assets = [{ image: '/assets/hero.jpg', sourceImage: heroSource }, ...seedMenu.filter(m => m.image)];
const results = await Promise.allSettled(assets.map(async asset => {
  const response = await fetch(asset.sourceImage, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`Image unavailable: ${asset.image}`);
  await writeFile(`public${asset.image}`, Buffer.from(await response.arrayBuffer()));
  return asset.image;
}));
for (const r of results) console.log(r.status === 'fulfilled' ? `Saved ${r.value}` : r.reason.message);
if (results.some(r => r.status === 'rejected')) process.exitCode = 1;
