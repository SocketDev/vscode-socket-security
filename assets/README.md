# Socket icon assets

Canonical Socket mark, fleet-shared. Distributed by socket-repo-template
to any repo that needs to ship a Socket logo (CLI logo art, VSCode
marketplace icon, web page favicon, README banner, …).

## Files

### SVG variants

| File | Layers | Color | viewBox |
|---|---|---|---|
| `socket-icon.svg` | 1 (bolt is a cutout) | `currentColor` | `0 0 181.41 240` |
| `socket-icon-square.svg` | 1 | `currentColor` | `-29.295 0 240 240` |
| `socket-icon-shield.svg` | 2 (shield + bolt) | shield: `currentColor`, bolt: `#fff` | `0 0 181.41 240` |
| `socket-icon-shield-square.svg` | 2 | shield: `currentColor`, bolt: `#fff` | `-29.295 0 240 240` |
| `socket-icon-brand.svg` ★ | 2 | shield: pink→purple gradient, bolt: `#fff` | `0 0 181.41 240` |
| `socket-icon-brand-square.svg` ★ | 2 | shield: pink→purple gradient, bolt: `#fff` | `-29.295 0 240 240` |

### PNG variants (rasterized brand-square)

| File | Use |
|---|---|
| `socket-icon-brand-16.png` | Favicon (small) |
| `socket-icon-brand-32.png` | Favicon (standard) |
| `socket-icon-brand-64.png` | README badges, GitHub social previews |
| `socket-icon-brand-128.png` | Docs, OG cards |
| `socket-icon-brand-256.png` | VSCode marketplace listing |
| `socket-icon-brand-512.png` | High-DPI, hero images, press kit |

The single-color variants treat the bolt as a cutout (negative space)
so the bolt always shows the background color through. Recolor via
parent CSS `color` (or inline `fill`).

The two-layer "shield" variants split the mark into independent shield
and bolt paths. Override either via `[data-socket-layer="shield"]` /
`[data-socket-layer="bolt"]` CSS selectors.

The "brand" variants are the canonical fully-colored Socket mark —
pink-to-purple horizontal gradient (`#f419b8` → `#9d5df8`) on the
shield, white bolt. Pixel-sampled from the original purple gradient
PNG. Use when you need a finished "Socket logo" with no theming work
(README banner, marketplace icon, social cards).

## Generator

`scripts/gen-socket-icon.mts` (in socket-repo-template, **not** synced
to adopting repos) writes all variants — SVGs and rasterized PNGs.
Adopting repos consume the produced files via sync-scaffolding without
needing the generator or its deps installed.

The generator depends on `@resvg/resvg-wasm` for SVG→PNG conversion —
pure WebAssembly, no native binaries, deterministic across platforms.

Run it after modifying source path data, gradient stops, or geometry.
Run with `--check` in CI to detect drift.

```sh
pnpm run gen-socket-icon          # write all variants (SVG + PNG)
pnpm run gen-socket-icon --check  # exit non-zero if any drift
```

## Source

Extracted from the canonical Socket logo (the icon is the lightning-
bolt mark on the left of the wordmark). Brand gradient stops sampled
from the historical `socket-square.png` listing icon using
ImageMagick. No external dependencies, no tracking.

## Adopters

Any fleet repo that ships visual branding should consume these. Don't
fork or recolor in-tree; if you need a tonal variant, override `color`
or use the two-layer / brand variants. If you need a tonal variant
that's not just a color override (e.g. a different gradient angle),
extend `gen-socket-icon.mts` upstream rather than forking the SVG in
your repo.
