import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Repo name as it will appear on GitHub
const repoName = 'ucsd-committee-network'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // For GitHub Pages, the site lives under /<repo-name>/
  // Locally (npm run dev), use root
  base: command === 'build' ? `/${repoName}/` : '/',
}))