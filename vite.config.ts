import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '**/.worktrees/**'],
  },
});
