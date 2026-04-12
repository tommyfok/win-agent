import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  async onSuccess() {
    const destDir = join('dist', 'workspace');
    mkdirSync(destDir, { recursive: true });
    copyFileSync(
      join('src', 'workspace', 'database-tool.template.ts'),
      join(destDir, 'database-tool.template.ts')
    );
    copyFileSync(
      join('src', 'workspace', 'database-tool-ambient.d.ts'),
      join(destDir, 'database-tool-ambient.d.ts')
    );
  },
});
