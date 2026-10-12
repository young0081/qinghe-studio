import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:3210' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: filename => /\.(woff2?|ttf)$/i.test(filename) ? false : undefined,
    rollupOptions: { output: { manualChunks(id) {
      const filename = id.replace(/\\/g, '/');
      if (!filename.includes('/node_modules/')) return;
      if (/\/node_modules\/(react|react-dom|scheduler)\//.test(filename)) return 'react';
      if (/\/node_modules\/(highlight\.js|lowlight|rehype-highlight)\//.test(filename)) return 'code-highlight';
      if (/\/node_modules\/katex\//.test(filename)) return 'math-renderer';
      return 'markdown-vendor';
    } } },
  },
});
