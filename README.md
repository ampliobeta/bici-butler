# Bici Butler

Ride HUD for TrainingPeaks Virtual. Built for Bulletproof Cycling Club.

## For Members

Download the latest release from the Releases tab:
- **Mac:** `Bici-Butler-mac.dmg`
- **Windows:** `Bici-Butler-windows.exe`

**First launch:**
1. Open the app
2. Enter your FTP when prompted
3. That's it — setup done forever

**Before each ride:**
1. Download your workout from TrainingPeaks as a `.zwo` file
2. Drop it in the Bici workout folder (the app shows you where)
3. Open Bici
4. In TPV: Settings → Broadcast → set URL to `http://127.0.0.1:8787/tp`
5. Turn off TPV's native HUD
6. Ride

## For Developers

```bash
npm install
npm start
```

## Building

Push to `main` — GitHub Actions builds Mac and Windows automatically.

Or build locally:
```bash
npm run build:mac    # Mac .dmg
npm run build:win    # Windows .exe (requires Windows)
```
