# Pen Pal

Tap HIT when you hit the pen. The camera opens so you can snap a pic with it, and everyone in your crew gets a push notification. The app shows who's out and a feed of recent hits.

It's a web app you install from Safari ("Add to Home Screen"), because Apple bans vaping apps from the App Store. It runs free with no card: the app is hosted on GitHub Pages, and the database, photos, logins and notifications run on Supabase's free plan.

## How it's put together

- `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `icons/`: the app GitHub Pages serves.
- `config.js`: the Supabase project address, its public key, and the public push key. These are safe to publish.
- `backend/schema.sql`: tables, security rules, crew create/join functions, live updates and photo storage. Run it once in Supabase → SQL Editor.
- `backend/notify/index.ts`: the Supabase Edge Function that sends push notifications. It needs these secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_JWK`, `VAPID_SUBJECT` (the app's URL), `APP_URL`.

## Install it on an iPhone

1. Open the app link in **Safari**.
2. Tap Share → **Add to Home Screen**.
3. Open Pen Pal from the home screen, enter your name, then start a crew or join one with a 6-letter code.
4. Tap **Turn on notifications** and allow them (needs iOS 16.4 or newer).

## Good to know

- Logins are anonymous and tied to the installed app. If someone deletes Pen Pal, they come back as a new person and rejoin with the code.
- Anyone with the crew code can join, so only share it with your crew.
- Pics are shrunk to about 200 KB. Anyone with a pic's link can open it, but the links are random and only shown inside your crew.
- Supabase pauses free projects after a week with no activity. If that happens, open supabase.com/dashboard and click **Restore**.
