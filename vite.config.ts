import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  test: {
    // The contribution checker uses node:test and has its own CI step.
    exclude: ['**/node_modules/**', '**/.git/**', '**/.worktrees/**', 'scripts/check-dco.test.cjs'],
  },
});
