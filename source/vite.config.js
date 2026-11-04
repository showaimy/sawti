import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { target: 'es2020', assetsInlineLimit: 0, minify: false },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
