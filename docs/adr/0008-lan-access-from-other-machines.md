# ADR 0008: Serving the UI to Other Machines on the LAN

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

The tool assumed one machine: backend, library and browser all on `127.0.0.1`. The library can
live on a different machine (a desktop or small server) while the user auditions and edits from
another one on the same network. The UI already uses same-origin relative URLs and the backend
serves the built SPA, so the blockers were the loopback-only origin guard and a few actions that
only make sense on the host: the native folder picker (a Tk dialog on the host's desktop) and
"Reveal in Explorer".

The network is trusted (home LAN). There is no authentication, and adding one was explicitly
out of scope.

## Decision

1. **Opt-in bind.** The default stays `127.0.0.1`. LAN access is `sfxsearch serve --host 0.0.0.0`
   (or `server.host` in `config.toml`), plus a firewall rule for the port.
2. **Same-origin mutating requests are allowed.** The CSRF guard accepts an `Origin` that is
   loopback or whose authority equals the request's `Host` header (the page was served by this
   server). Cross-site origins still get 403. DNS rebinding is not defended; that is accepted on a
   trusted LAN and would need real auth.
3. **Host-machine-only actions.** Library folder setup (add, remove, rescan, native picker) and
   Reveal in Explorer return 403 unless the TCP peer is loopback. Folders are configured by using
   the app on the host via `http://localhost:<port>`, not its LAN address.
4. **The UI follows the server.** `GET /api/library` returns `is_local`; the web app hides the
   controls it cannot use (Reveal button and `R`, Copy path, Add/Remove folder, Scan/Rebuild,
   Studio "Show in Explorer") and shows the Folders list read-only. A first-run screen on a remote
   client says setup happens on the host. Search, playback, favorites, the Studio, and saving into
   existing library folders work from any client.

## Consequences

- Anyone on the LAN can read the library's metadata and audio, change favorites/tags/notes, and
  save audio into configured library folders (`overwrite` can replace files there). They cannot
  add roots, so they cannot reach other directories on the host.
- A browser on the host that opens the LAN address counts as remote.
- Paths shown in the UI are host paths. Copy path is hidden remotely because it would copy a path
  that means nothing on the client.
- Not covered: HTTPS (needed for secure-context browser APIs, though none are required now),
  authentication, and the MCP HTTP transports, whose own host checks were not verified.
