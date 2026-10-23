---
title: Targets
description: Run the same app as a macOS, Windows or Linux window, or on iOS and Android.
---

One app runs on every target. The web build is the base; the native targets wrap the same React app in a native shell.

```sh
pnpm parlor dev --target mac      # also windows, linux
pnpm parlor dev --target ios      # also android
```

| Target | Shell | Needs |
| --- | --- | --- |
| `web` | the browser, installable as a PWA | nothing |
| `mac`, `windows`, `linux` | Tauri | Rust (`rustup`), and the platform's build tools |
| `ios` | Capacitor | macOS with Xcode |
| `android` | Capacitor | the Android SDK |

`--device <name>` picks a simulator or device for iOS and Android. A desktop target can only be built on its own operating system.

To try several targets at once, name them together:

```sh
pnpm parlor dev --target web,mac
```

They share one server and one database, and the native ones act as the web app's origin, so connecting your computer once serves all of them, as in production. Each project runs one `parlor dev` at a time: a second one stops and names the one already running, because both would open the same database.

Generated native projects live in `.parlor/`. Never edit them; they are rewritten on every run.

## What changes per platform

Nothing in your app code. Platform features such as notifications, deep links or a secure session store are capabilities with one interface and an adapter per platform. Ask for one with `useCapability`, and check `available` instead of checking the platform. See the [capabilities reference](/reference/capabilities/).

## Desktop settings

`parlor.config.ts` has a `desktop` section: `width` and `height` of the window, and `agentHost: true` to bundle Parlor Host in the app so the agent sidebar can reach the agents on the user's computer.

## Building

```sh
pnpm parlor build --target mac
```

writes the app bundle; `--target ios` and `--target android` sync the native project, which you open in Xcode or Android Studio to sign and ship.
