# RenStep

A step tracker, workout log, rule-based coach and XP/badge system that runs as a Home Screen web app on iPhone. No accounts, no server, no data leaves the phone.

## Install on iPhone
1. Open the app's https link in **Safari** (not Chrome).
2. Tap Share, then **Add to Home Screen**, then Add.
3. Open RenStep from the Home Screen icon from now on. The Home Screen app keeps its own data, separate from the Safari tab.

## Steps from Apple Health
Settings (gear icon) in the app has the Shortcut recipe. In short: Find Health Samples (Steps, today, Group By Day) → Calculate Statistics (Sum) → Format Date (yyyy-MM-dd) → Text `RENSTEP [date] [sum]` → Copy to Clipboard. Run it, open RenStep, tap **Add steps → Paste from Shortcut**. You can also type steps in by hand for any past day.

## How the coach works
Each exercise has a rep range and a weight step. Hit the top of the range on every set and next time adds the weight step. Miss the bottom of the range and you stay put. Miss it two sessions running and it drops about 10%. Bodyweight moves (weight 0) progress by reps. The step goal is 10% above your median of the last 14 days, between 5,000 and 15,000.

## XP
Workout: 50 + 2 per set + 10 per personal record. Steps: 2 per 1,000 plus 25 for hitting the goal, counted once the day is over. Level n starts at 100 × (n−1)² XP.

## Backups
Data lives in the browser storage of the Home Screen app. Deleting the app, or clearing Safari website data, wipes it. Use Settings → Export backup every couple of weeks and save the file to Files or iCloud Drive. Restore from the same screen.

## Security notes
- Static files only. No backend, no third-party scripts, no analytics; a Content Security Policy blocks inline and external scripts.
- User text is rendered with `textContent`, never `innerHTML`.
- Backup imports are size-limited and validated field by field before use.
- The code is public if hosted on a public GitHub repo, but your data never is: it is never sent anywhere.

## Files
`index.html`, `styles.css`, `app.js` (all logic), `sw.js` (offline cache), `manifest.webmanifest`, `icons/`.
After changing files, bump `CACHE` in `sw.js` so phones pick up the new version.
