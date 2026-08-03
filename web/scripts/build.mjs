/**
 * Portable production-build launcher for the web application.
 *
 * Vite honors an inherited NODE_ENV even during `vite build`; setting it
 * before dynamically importing Vite keeps local, CI, Docker, and Windows
 * bundle measurements on the same production transform.
 */

process.env.NODE_ENV = 'production'

const { build } = await import('vite')
await build()
