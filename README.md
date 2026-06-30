# 22 — Aligner Wear Tracker

A voice-first, **serverless** Progressive Web App that helps you keep clear aligners (Invisalign-style) in for **22 hours a day**.

Live: **https://awreccan.github.io/aligners/**

## What it does
- Reframes "22h in" as a **2-hour daily out-budget** that drains as you eat/drink.
- One giant tap toggle (IN / OUT) + a live out-budget ring (green → amber → red).
- "worn today", "out today", and a 7-day history at a glance.
- **Voice:** "Hey Siri, Aligners off / on" via two iOS Shortcuts.
- **Reliable reminders:** native iOS reminders created by the Shortcut fire even when the phone is locked/on silent.

## How it's serverless
There is **no backend server**. The shared wear-log lives in a **private GitHub Gist**, read & written by both the web app and the iOS Shortcuts through the CORS-open GitHub API. First launch walks you through creating a `gist`-scope token (stored only on your device) and a private gist.

## Files
- `index.html` / `styles.css` — the UI (+ first-run setup screen)
- `wear-core.js` — pure wear-time / out-budget / reminder-ladder logic (timezone-aware, midnight-clipping)
- `gist-store.js` — the GitHub-Gist data layer (read/write the event log)
- `app.js` — controller (toggle, live ring, offline cache, sync)
- `service-worker.js` / `manifest.json` — installable PWA + offline shell

## Install on iPhone
Open the live URL in Safari → Share → **Add to Home Screen**. Complete the one-time sync setup. For voice + reminders, set up the two Shortcuts (see the project's `shortcuts/` recipes).
