# Changelog

To update: **Macro Logger → Check for updates** in your Sheet. It shows the new code and the steps to paste it in.

## 1.0.0

First versioned release.

- **Settings tab.** Time zone, hand size, the food you usually eat, a few words about you, Gemini models and weight sync now live in the Sheet instead of the code.
- **Macro Logger menu.** *Set up / repair* asks for your Gemini key, makes your Shortcut token, checks your web app URL and shows the URL + token. There's no more editing Script Properties.
- **Update notice.** The notification and the Daily tab say when a new version is out. *Check for updates* shows the new code with a Copy button and the steps to install it. Your web app URL stays the same.
- *Change Gemini key* and *Make a new Shortcut token* menu items, for when a key or token leaks.
- Fix: the hand width in inches was calculated from the hand length.
- Fix: the weight chart started at 0 kg, which flattened any change. It now zooms to your own weight range, 1 kg above and below.
- Security: food names, notes and suggestions starting with `=` are saved as plain text, so text from a photo can't turn into a spreadsheet formula.
- Security: the update check ignores a version number that isn't in the form `1.2.3`.

**Upgrading from before 1.0.0** (one time only): paste the new `Code.js` and `appsscript.json` by hand (see the README's manual install), then click **Macro Logger → Set up / repair**. Paste your existing `/exec` URL when it asks, and deploy a New version (Deploy → Manage deployments), so your URL stays the same. Enter your own hand size and other details on the new Settings tab.
