import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base = process.env.ERP_BASE_PATH?.trim() || './';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: true,
  },
});
