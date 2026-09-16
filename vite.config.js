import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // GitHub Pages serves this from /neomed-collection-manager/
  base: process.env.GITHUB_ACTIONS ? '/neomed-collection-manager/' : '/',
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
