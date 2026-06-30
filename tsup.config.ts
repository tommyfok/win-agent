import fs from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: false,
  dts: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  async onSuccess() {
    const destDir = join('dist', 'workspace');
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(
      join('src', 'workspace', 'database-tool.template.ts'),
      join(destDir, 'database-tool.template.ts')
    );
    fs.copyFileSync(
      join('src', 'workspace', 'database-tool-ambient.d.ts'),
      join(destDir, 'database-tool-ambient.d.ts')
    );

    // Ship the bundled agent-skills methodology pack so `win-agent init` /
    // `win-agent skills sync-agent-skills` can sync it into target projects.
    fs.cpSync(join('src', 'templates', 'skills'), join('dist', 'templates', 'skills'), {
      recursive: true,
    });
  },
});
