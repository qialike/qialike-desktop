import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // The farm tests copy real package trees and inspect the real checkouts, so
    // they need more than the default budget on a cold filesystem.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
