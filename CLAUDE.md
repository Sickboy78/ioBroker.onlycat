# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run lint          # ESLint (eslint.config.mjs)
npm run check         # TypeScript type check (no emit)
npm test              # Runs test:js + test:package
npm run test:js       # Mocha unit tests
npm run test:package  # Package validation tests
npm run test:integration  # Integration tests
npm run translate     # Update i18n translation files
npm run release       # AlCalzone release script
```

To run a single test file:
```bash
npx mocha --require test/mocha.setup.js path/to/test.test.js
```

## Architecture

This is an ioBroker adapter for OnlyCat smart cat flaps with AI prey detection. It runs as a **daemon** with a persistent **Socket.IO** connection to the OnlyCat cloud API (`https://gateway.onlycat.com`).

### Key Files

- **main.js** — The adapter class (~2700 lines). Extends `@iobroker/adapter-core`. Contains all state management, event processing, and ioBroker object creation.
- **lib/onlycat-api.js** — Wraps the Socket.IO client. Handles auth (encrypted device token), connection lifecycle, and emits RxJS observables for incoming data.

### Data Flow

1. `onReady()` initializes the connection via `OnlyCatApi`
2. The API receives push events from the cloud: devices, RFIDs, transit policies, and cat flap events
3. `main.js` maps these to ioBroker states/objects, creating a state tree per device
4. State changes from ioBroker (e.g., `disconnect`, `reconnect`, `getEvents`) trigger actions back to the API

### State Tree Structure (per device)

ioBroker objects are created dynamically based on API responses. The structure is defined by constants in `main.js` and schema in `io-package.json`.

### Test Framework

Mocha + Chai (`should` interface) + Sinon + `chai-as-promised`. Test setup is in `test/mocha.setup.js`. Unit tests live alongside source as `*.test.js` files.

### i18n

Admin UI strings are in `admin/i18n/` (11 languages). Run `npm run translate` after adding new English strings to auto-translate.