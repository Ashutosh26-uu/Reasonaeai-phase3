import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // pre-transform the app on startup so the first browser load is fast
    warmup: { clientFiles: ['./src/main.jsx', './src/App.jsx', './src/pages/*.jsx'] },
  },
})
