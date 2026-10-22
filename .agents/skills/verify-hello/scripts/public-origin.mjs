// Preloaded (NODE_OPTIONS=--import) into the processes of a forwarded dev instance. `parlor dev`
// sets the server's PARLOR_WEB_ORIGIN from web.port, which is Vite's internal port there; the
// instance's origin is the forwarder's port, so the server gets that one.
if (process.env.HELLO_PUBLIC_ORIGIN) {
  process.env.PARLOR_WEB_ORIGIN = process.env.HELLO_PUBLIC_ORIGIN;
}
