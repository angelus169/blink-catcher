# Chrome Web Store listing

Copy-paste values for the developer dashboard. Rebuild the images with `node store/make-assets.mjs`
and the package with `./scripts/build-zip.sh`.

## Package

`dist/blink-catcher-<version>.zip`

## Store listing

**Name:** Blink Catcher

**Summary** (max 132 characters):

> Catches hidden one-frame messages in Instagram Reels and keeps each one as a full-size image.

**Category:** Tools (or the closest match the dashboard offers)

**Language:** English

**Description:**

```
Some Reels hide a message in one single frame: a code, a link, a "you found it" note. It flashes by in 1/30 of a second, and pausing on it by hand is almost impossible.

Blink Catcher checks every frame while you watch. When 1–3 frames do not belong to the video around them, it keeps them as full-size images, with the frames before and after for context.

• Works while you watch: no upload, nothing leaves your browser
• Catches full-screen inserts, small stickers and inserts at a scene cut
• Opens each catch full size: download it as PNG or jump the video to it
• Optional: pause the video on the caught frame
• Sensitivity (Low / Normal / High) and slow playback (0.5×, 0.25×)
• One switch to turn checking off

Blink Catcher is not affiliated with Instagram or Meta.

Open source: https://github.com/angelus169/blink-catcher
```

**Images:**

| Field | File |
|---|---|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshots (1280×800) | `store/screenshot-viewer.png`, `store/screenshot-panel.png` |
| Small promo tile (440×280) | `store/promo-440x280.png` |

Do not use the Instagram logo or name in the images as if it were an official product.

## Privacy practices

**Single purpose:**

> Find and keep short (1–3 frame) inserts in videos that the user plays on instagram.com.

**Permission justification:**

- `storage`: Saves the user's three settings (on/off, sensitivity, pause on catch) on the device.
- Host permission `https://www.instagram.com/*`: The content script reads the frames of videos the
  user plays on instagram.com to find inserted frames, and shows the on-page panel. Nothing is sent
  anywhere.

**Remote code:** No. All code is in the package.

**Data usage:** collects none of the listed data types. Tick the three certifications
(no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://github.com/angelus169/blink-catcher/blob/main/PRIVACY.md
