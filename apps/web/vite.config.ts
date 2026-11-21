import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// In development the API runs on :3000; the proxy keeps cookies same-origin (no CORS needed).
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5400,
    host: '127.0.0.1',
    proxy: {
      '/v1': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false },
      '/health': { target: process.env.API_URL ?? 'http://localhost:3000' },
    },
  },
});
