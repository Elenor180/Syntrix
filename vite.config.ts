import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the heaviest vendor paths while leaving Amplify's internal graph intact.
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }

          if (id.includes('@aws-sdk/client-lambda') || id.includes('@smithy') || id.includes('@aws-crypto')) {
            return 'aws-sdk'
          }

          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/scheduler/')
          ) {
            return 'react-vendor'
          }
        },
      },
    },
  },
})
