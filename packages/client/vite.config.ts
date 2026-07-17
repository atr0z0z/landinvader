import { defineConfig } from 'vite';

export default defineConfig({
  // Относительные пути к ассетам — работают и на домене, и в подпапке.
  base: './',
  server: {
    port: 5173,
  },
});
