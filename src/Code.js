/**
 * Macro Logger — Google Apps Script backend
 *
 * Setup (full guide in README.md):
 * 1. Make a copy of the template Sheet (the code comes with it).
 * 2. In the Sheet: Macro Logger → Set up / repair. It asks for your Gemini key, creates your
 *    Shortcut token, walks you through deploying the web app, and shows the URL + token
 *    for the iPhone Shortcuts.
 * 3. Fill in the Settings tab (time zone, hand size, food you eat) and the Targets tab.
 *
 * Updates: the notification and Daily tab say when a new release is out. Macro Logger →
 * Check for updates shows the new code with a Copy button and the steps to paste + redeploy.
 * Nothing personal lives in this file — it's all in the Settings and Targets tabs and Script
 * Properties — so pasting a new version never loses anything.
 *
 * Weight logging: POST {"type": "weight", "weight": 65.4, "token": "..."}
 * → one row per day in the "Weight" tab (created automatically on first log).
 *
 * Foods database (see the Foods section at the bottom):
 *   GET  ?action=foods&token=...                       → list of saved foods for the Shortcut
 *   POST {"type": "quick", "food": "...", "servings": 1, "token": "..."} → logs a saved food
 *
 * Next-meal suggestions: after each photo log, suggests what to eat to fill your remaining
 * macros (needs the Targets tab). Returned as "suggestion" and written to the Daily tab.
 */

const VERSION = '1.0.1'; // must match the VERSION file; bump both for every release
const REPO = 'tlmotan/opensource-ai-macro-tracker'; // where updates come from (forks: change this)

// iCloud links for the Shortcuts, shown in Macro Logger → Show my Shortcut details.
// Only ever put links to the clean shareable copies here (see docs/PUBLISHING.md).
const SHORTCUT_LINKS = [
  ['Log Meal', ''],
  ['Log Weight', '']
];

const SHEET_NAME = 'Log';
const LOG_COLS = 9; // Timestamp … Note, Food ID
const RETRIES_PER_MODEL = 1; // keep total time under the Shortcut's timeout

// ─────────────────────────────────────────────────────────────
// Settings tab: everything personal lives here, not in the code
// ─────────────────────────────────────────────────────────────

const SETTINGS_SHEET = 'Settings';

// [key, default, what it means]. Keys added in later versions appear automatically;
// values people have already typed in are never overwritten.
const SETTINGS = [
  ['time_zone', 'Asia/Kuala_Lumpur',
    'Your time zone, e.g. Asia/Singapore or Europe/London ("TZ identifier" column at en.wikipedia.org/wiki/List_of_tz_database_time_zones). After changing it, click Macro Logger → Set up / repair.'],
  ['day_start_hour', 4,
    'Food eaten before this hour counts towards the previous day (4 = 4 AM). After changing it, click Macro Logger → Set up / repair.'],
  ['hand_length_cm', 18,
    'Base of your palm to the tip of your middle finger. Measure your own: the AI uses your hand in the photo to judge portion size.'],
  ['hand_width_cm', 8.5,
    'Across your palm, side to side.'],
  ['usual_food', 'Malaysian food (hawker, kopitiam, economy rice, mamak)',
    'The kind of food you usually eat. Helps the AI recognise dishes and suggest meals.'],
  ['about_me', 'someone living in Malaysia',
    'A few words about you for meal suggestions, e.g. "a university student in Malaysia".'],
  ['photo_models', 'gemini-3.6-flash, gemini-3.5-flash-lite',
    'Gemini models for photos, tried in order (the next is used if one is busy). Only change if a model stops working.'],
  ['suggest_models', 'gemini-3.5-flash-lite, gemini-3.6-flash',
    'Gemini models for meal suggestions, tried in order.'],
  ['sync_weight_to_targets', true,
    'Copy each logged weight into Targets!B4, so your calorie targets follow your weight.']
];

let settingsCache = null; // read once per request

// Settings from the Settings tab, with defaults for anything missing or blank.
function getSettings() {
  if (settingsCache) return settingsCache;
  const values = {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_SHEET);
  if (sheet && sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(([k, v]) => {
      if (k !== '' && v !== '' && v !== null) values[String(k).trim()] = v;
    });
  }

  const s = {};
  SETTINGS.forEach(([key, def]) => {
    const v = key in values ? values[key] : def;
    if (key.endsWith('_models')) {
      s[key] = String(v).split(',').map(x => x.trim()).filter(Boolean);
    } else if (typeof def === 'boolean') {
      s[key] = v === true || String(v).toUpperCase() === 'TRUE';
    } else if (typeof def === 'number') {
      s[key] = isNaN(Number(v)) ? def : Number(v);
    } else {
      s[key] = String(v).trim();
    }
  });
  settingsCache = s;
  return s;
}

// Creates the Settings tab and adds any missing keys. Never touches values already there.
function ensureSettingsTab() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
    sheet.getRange('A1:C1').setValues([['Setting', 'Your value', 'What it means']])
      .setFontWeight('bold').setBackground('#e8f0fe');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(2, 340);
    sheet.setColumnWidth(3, 560);
  }

  const have = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim())
    : [];
  SETTINGS.filter(([key]) => !have.includes(key)).forEach(([key, def, help]) => {
    const row = sheet.getLastRow() + 1;
    sheet.getRange(row, 1, 1, 3).setValues([[key, def, help]]);
    if (typeof def === 'boolean') sheet.getRange(row, 2).insertCheckboxes().setValue(def);
  });

  // Refresh the explanations (they're not user data) and the formatting
  const rows = sheet.getLastRow() - 1;
  const help = Object.fromEntries(SETTINGS.map(([key, , h]) => [key, h]));
  const keys = sheet.getRange(2, 1, rows, 1).getValues();
  sheet.getRange(2, 3, rows, 1).setValues(keys.map(([k]) => [help[k] || '']));
  sheet.getRange(2, 1, rows, 1).setFontColor('#888888');
  sheet.getRange(2, 2, rows, 1).setBackground('#fff8e1').setHorizontalAlignment('left'); // editable
  sheet.getRange(2, 3, rows, 1).setFontColor('#666666').setWrap(true);

  settingsCache = null;
  return sheet;
}

// Which "food day" a timestamp belongs to, e.g. 1 AM on the 25th → the 24th.
function foodDay(d) {
  const s = getSettings();
  return Utilities.formatDate(new Date(d.getTime() - s.day_start_hour * 3600000), s.time_zone, 'yyyy-MM-dd');
}

function buildPhotoPrompt(s) {
  const inches = cm => Math.round(cm / 2.54 * 10) / 10;
  return `You are a nutrition estimator with strong knowledge of ${s.usual_food}.

SCALE REFERENCE: The user's hand usually appears in the photo. It is ${s.hand_length_cm} cm
(${inches(s.hand_length_cm)} in) from the base of the palm to the tip of the middle finger, and ${s.hand_width_cm} cm
(${inches(s.hand_width_cm)} in) wide from side to side. Use both dimensions to judge plate size, portion area, and food
thickness. If no hand is visible, use the plate, bowl or cutlery for scale
and lower your confidence.

METHOD:
1. List every component separately: rice/noodles, each protein, each vegetable, sauces/gravy/kuah,
   and visible oil.
2. Estimate each component's cooked weight in grams using the hand for scale.
3. Work out macros from those weights, accounting for cooking method (deep-fried vs steamed,
   skin on, oil and gravy soaked into rice).
4. Sum the components for the totals.

If the user note conflicts with the photo, trust the note.
Keep "food" to a short description (under 8 words).
Keep each item "name" short and plain (2–4 words, e.g. "white rice", "fried chicken thigh").
Set confidence to "low", "medium" or "high".

FOOD ID: Give "food_id" as a stable snake_case id for the dish as a whole, generic enough that the
same meal eaten again gets the same id (e.g. roasted_chicken_rice, salmon_fillet_cooked,
nasi_lemak_ayam_goreng). Ignore portion size and small variations. If the dish matches one of the
KNOWN IDS listed below, reuse that exact id.`;
}

// Opening the /exec URL in a browser should show this — confirms the deployment works.
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'foods') {
    const token = PropertiesService.getScriptProperties().getProperty('SHORTCUT_TOKEN');
    if (!token || p.token !== token) {
      return json({ error: 'unauthorized' });
    }
    return json({ foods: foodList().map(f => f.label) });
  }
  return json({ status: 'ok', version: VERSION, message: 'Macro logger is running. Send photos via POST.' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();

    const token = props.getProperty('SHORTCUT_TOKEN');
    if (!token || body.token !== token) {
      return json({ error: 'unauthorized' });
    }

    const note = (body.note || '').trim();

    if (body.type === 'weight') {
      return json(Object.assign(logWeight(body.weight), { update: updateNotice() }));
    }
    if (body.type === 'quick') {
      return json(Object.assign(quickLog(body.food, body.servings), todayTotals()));
    }

    const macros = estimateMacros(body.image, note, props.getProperty('GEMINI_API_KEY'), knownFoodIds());
    appendRow(macros, note);

    let suggestion = '';
    try {
      suggestion = suggestNextMeal(props.getProperty('GEMINI_API_KEY'));
    } catch (err) {
      console.warn('Suggestion failed: ' + err); // logging still succeeded
    }
    return json(Object.assign(macros, todayTotals(), { suggestion, update: updateNotice() }));
  } catch (err) {
    return json({ error: String(err) });
  }
}

function estimateMacros(imageB64, note, apiKey, knownIds) {
  const payload = {
    contents: [{
      parts: [
        { text: buildPhotoPrompt(getSettings()) + `\nKNOWN IDS: ${(knownIds || []).join(', ') || '(none yet)'}` + (note ? `\nUser note: ${note}` : '') },
        { inline_data: { mime_type: 'image/jpeg', data: imageB64 } }
      ]
    }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: 'low' }, // much faster; plenty for macro estimates
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name:  { type: 'STRING' },
                grams: { type: 'NUMBER' },
                kcal:  { type: 'NUMBER' }
              },
              required: ['name', 'grams', 'kcal']
            }
          },
          food:       { type: 'STRING' },
          food_id:    { type: 'STRING' },
          kcal:       { type: 'NUMBER' },
          protein_g:  { type: 'NUMBER' },
          carbs_g:    { type: 'NUMBER' },
          fat_g:      { type: 'NUMBER' },
          confidence: { type: 'STRING' }
        },
        // Breakdown comes first, so totals are built from the per-item estimates
        propertyOrdering: ['items', 'food', 'food_id', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence'],
        required: ['items', 'food', 'food_id', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence']
      }
    }
  };

  const m = callGemini(getSettings().photo_models, payload, apiKey);

  // Round to whole numbers for a cleaner sheet
  ['kcal', 'protein_g', 'carbs_g', 'fat_g'].forEach(k => m[k] = Math.round(m[k]));
  return m;
}

// Sends a request to the first model that isn't busy/over quota; returns the parsed JSON reply.
function callGemini(models, payload, apiKey) {
  let res, lastError = '';
  outer:
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    for (let attempt = 0; attempt < RETRIES_PER_MODEL; attempt++) {
      res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      const code = res.getResponseCode();
      if (code === 200) break outer;
      lastError = `Gemini ${model} ${code}: ${res.getContentText()}`;
      if (code !== 503 && code !== 429 && code !== 500) throw new Error(lastError); // real error, don't retry
      Utilities.sleep(500); // brief pause before trying the next model
    }
  }
  if (res.getResponseCode() !== 200) throw new Error(lastError);

  const data = JSON.parse(res.getContentText());
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

function appendRow(m, note) {
  const id = String(m.food_id || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  addMealRow([new Date(), m.food, m.kcal, m.protein_g, m.carbs_g, m.fat_g, m.confidence,
              formatNote(note, m.items), id]);
}

// Note cell: your note on the first line, then one bullet per component, e.g.
//   Note: extra kuah
//   • white rice: ~200 g, ~260 kcal
//   • fried chicken thigh: ~120 g, ~310 kcal
function formatNote(note, items) {
  const lines = (items || []).map(i =>
    `• ${String(i.name).trim()}: ~${Math.round(i.grams)} g, ~${Math.round(i.kcal)} kcal`);
  if (note) lines.unshift(`Note: ${note}`);
  return lines.join('\n');
}

// Turns notes saved by older versions ("extra kuah | rice ~200g, chicken ~120g") into bullets.
// Leaves anything else (quick-log notes, text you typed yourself) exactly as it is.
function tidyOldNote(s) {
  s = String(s || '');
  if (!s || s.includes('\n')) return s;
  const parts = s.split(' | ');
  const items = parts[parts.length - 1].split(', ').map(x => x.trim());
  if (!items.every(x => /\s~\d+g$/.test(x))) return s;
  const lines = items.map(x => `• ${x.replace(/\s~(\d+)g$/, ': ~$1 g')}`);
  if (parts.length > 1) lines.unshift(`Note: ${parts.slice(0, -1).join(' | ')}`);
  return lines.join('\n');
}

// Appends one meal, regroups the Log by day, and refreshes the Foods tab.
function addMealRow(row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000); // avoid two logs rebuilding the sheet at the same time
  try {
    getLogSheet().appendRow(row);
    rebuildLog();
    updateFoods();
  } finally {
    lock.releaseLock();
  }
}

function getLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = getSettings().time_zone;
  if (ss.getSpreadsheetTimeZone() !== tz) ss.setSpreadsheetTimeZone(tz);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Food', 'Kcal', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Confidence', 'Note', 'Food ID']);
    sheet.setFrozenRows(1);
  }
  if (sheet.getRange('I1').getValue() === '') sheet.getRange('I1').setValue('Food ID').setFontWeight('bold');
  return sheet;
}

// Regroups the Log by day: each day's meals, followed by a bold TOTAL row.
// Runs automatically after every log; you can also run it by hand after editing/deleting rows.
function rebuildLog() {
  const sheet = getLogSheet();
  const last = sheet.getLastRow();
  if (last < 2) return;

  const meals = sheet.getRange(2, 1, last - 1, LOG_COLS).getValues()
    .filter(r => r[0] instanceof Date && r[1] !== 'TOTAL')
    .sort((a, b) => a[0] - b[0]);
  meals.forEach(r => { r[7] = tidyOldNote(r[7]); });

  const out = [];
  const totalRows = [];
  let i = 0;
  while (i < meals.length) {
    const day = foodDay(meals[i][0]);
    const start = out.length + 2;
    while (i < meals.length && foodDay(meals[i][0]) === day) out.push(meals[i++]);
    const end = out.length + 1;
    totalRows.push(out.length + 2);
    out.push([new Date(out[out.length - 1][0].getTime() - getSettings().day_start_hour * 3600000), 'TOTAL',
      `=SUM(C${start}:C${end})`, `=SUM(D${start}:D${end})`,
      `=SUM(E${start}:E${end})`, `=SUM(F${start}:F${end})`, '', '', '']);
  }

  sheet.getRange(2, 1, last - 1, LOG_COLS).clear();
  if (!out.length) return;
  sheet.getRange(2, 1, out.length, LOG_COLS).setValues(out);

  // Formatting: meals show date + time, TOTAL rows show just the day
  sheet.getRange(2, 1, out.length, 1).setNumberFormat('d mmm yyyy, h:mm am/pm');
  sheet.getRange(2, 1, out.length, LOG_COLS).setVerticalAlignment('top'); // tidy next to tall notes
  sheet.getRange(2, 8, out.length, 1).setWrap(true);                      // Note: bullets on their own lines
  sheet.setColumnWidth(8, 320);
  totalRows.forEach(r => {
    const row = sheet.getRange(r, 1, 1, LOG_COLS);
    row.setFontWeight('bold').setBackground('#e8f0fe')
       .setBorder(true, null, true, null, null, null);
    sheet.getRange(r, 1).setNumberFormat('ddd, d mmm yyyy');
  });

  applyTargetColors(sheet);
}

// Sums everything logged today (in the Settings time zone).
function todayTotals() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const t = { today_kcal: 0, today_protein_g: 0, today_carbs_g: 0, today_fat_g: 0 };
  if (!sheet || sheet.getLastRow() < 2) return t;

  const today = foodDay(new Date());
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();

  rows.forEach(r => {
    if (r[0] instanceof Date && r[1] !== 'TOTAL' && foodDay(r[0]) === today) {
      t.today_kcal      += Number(r[2]) || 0;
      t.today_protein_g += Number(r[3]) || 0;
      t.today_carbs_g   += Number(r[4]) || 0;
      t.today_fat_g     += Number(r[5]) || 0;
    }
  });
  return t;
}

// Builds the "Daily" tab: today's totals + a per-day history. Run by Set up / repair; safe to re-run.
function setupDaily() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s = getSettings();
  ss.setSpreadsheetTimeZone(s.time_zone); // so dates match your day
  const dayStart = s.day_start_hour;

  const sheet = ss.getSheetByName('Daily') || ss.insertSheet('Daily', 0);
  sheet.clear();

  // Today section (updates live as rows are added to Log)
  sheet.getRange('A1:E1').setValues([['Today', 'Kcal', 'Protein (g)', 'Carbs (g)', 'Fat (g)']]);
  sheet.getRange('A2').setFormula(`=INT(NOW() - ${dayStart}/24)`); // today's food day
  ['C', 'D', 'E', 'F'].forEach((logCol, i) => {
    sheet.getRange(2, i + 2).setFormula(
      `=SUMIFS(${SHEET_NAME}!${logCol}:${logCol}, ${SHEET_NAME}!$A:$A, ">="&($A$2+${dayStart}/24), ${SHEET_NAME}!$A:$A, "<"&($A$2+1+${dayStart}/24), ${SHEET_NAME}!$B:$B, "<>TOTAL")`
    );
  });

  // History: one row per day, newest first
  sheet.getRange('A4').setValue('History');
  sheet.getRange('A5').setFormula(
    `=QUERY({ARRAYFORMULA(IF(${SHEET_NAME}!A2:A="",,INT(${SHEET_NAME}!A2:A - ${dayStart}/24))), ${SHEET_NAME}!B2:F}, ` +
    `"select Col1, sum(Col3), sum(Col4), sum(Col5), sum(Col6) where Col1 is not null and Col2 <> 'TOTAL' ` +
    `group by Col1 order by Col1 desc ` +
    `label Col1 'Date', sum(Col3) 'Kcal', sum(Col4) 'Protein (g)', sum(Col5) 'Carbs (g)', sum(Col6) 'Fat (g)'", 0)`
  );

  // Formatting
  sheet.getRange('A2').setNumberFormat('ddd, d mmm yyyy');
  sheet.getRange('A6:A').setNumberFormat('ddd, d mmm yyyy');
  sheet.getRange('A1:E1').setFontWeight('bold').setBackground('#e8f0fe');
  sheet.getRange('A4').setFontWeight('bold');
  sheet.getRange('A5:E5').setFontWeight('bold');
  sheet.getRange('B2:E2').setFontSize(14).setFontWeight('bold');
  sheet.setColumnWidth(1, 160);
  sheet.setFrozenRows(2);
  ss.setActiveSheet(sheet);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
// Macro Logger menu: setup, Shortcut details, updates
// ─────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Macro Logger')
    .addItem('Set up / repair', 'setup')
    .addItem('Show my Shortcut details', 'showShortcutDetails')
    .addSeparator()
    .addItem('Check for updates', 'checkForUpdates')
    .addSeparator()
    .addItem('Refresh suggestions', 'refreshSuggestions')
    .addItem('Rebuild log', 'rebuildLog')
    .addSeparator()
    .addItem('Change Gemini key', 'changeGeminiKey')
    .addItem('Make a new Shortcut token', 'newShortcutToken')
    .addToUi();

  // After an update, finish it the first time the Sheet is opened (adds new settings, rebuilds tabs)
  try {
    if (PropertiesService.getScriptProperties().getProperty('SETUP_VERSION') !== VERSION) ensureSetup();
  } catch (err) {
    console.warn('Post-update setup failed: ' + err); // Set up / repair will retry it
  }
}

// Creates or repairs every tab. Never overwrites your details or settings.
function ensureSetup() {
  ensureSettingsTab();
  getLogSheet();
  setupTargets();
  setupDaily();
  const weight = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WEIGHT_SHEET);
  if (weight) fitWeightChart(weight);
  PropertiesService.getScriptProperties().setProperty('SETUP_VERSION', VERSION);
}

// Macro Logger → Set up / repair. Safe to run any time: it only asks for what's missing or broken.
function setup() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  ensureSetup();

  if (!props.getProperty('GEMINI_API_KEY')) {
    const key = askForGeminiKey(ui);
    if (!key) return;
    props.setProperty('GEMINI_API_KEY', key);
  }
  if (!props.getProperty('SHORTCUT_TOKEN')) props.setProperty('SHORTCUT_TOKEN', makeToken());

  const saved = props.getProperty('WEB_APP_URL');
  if (!saved || checkWebAppUrl(saved)) {
    const url = askForWebAppUrl(ui);
    if (!url) return;
    props.setProperty('WEB_APP_URL', url);
  }

  SpreadsheetApp.getActiveSpreadsheet().setActiveSheet(ensureSettingsTab());
  showShortcutDetails();
}

function changeGeminiKey() {
  const key = askForGeminiKey(SpreadsheetApp.getUi());
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  SpreadsheetApp.getActiveSpreadsheet().toast('Gemini key saved', 'Macro Logger');
}

// Use this if your token was shared by accident: the old one stops working immediately.
function newShortcutToken() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('Make a new Shortcut token?',
    'Your Shortcuts will stop working until you paste the new token into them.', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty('SHORTCUT_TOKEN', makeToken());
  showShortcutDetails();
}

const makeToken = () => Utilities.getUuid().replace(/-/g, '').slice(0, 16);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// For dialogs: copy('fieldId', button) copies a field's text to the clipboard
const COPY_SCRIPT = `<script>
  function copy(id, btn) {
    const el = document.getElementById(id);
    el.select();
    const done = () => { btn.textContent = 'Copied'; };
    (navigator.clipboard ? navigator.clipboard.writeText(el.value) : Promise.reject())
      .then(done, () => { document.execCommand('copy'); done(); });
  }
</script>`;

// Asks for a Gemini key until a working one is pasted (or Cancel). Returns '' on cancel.
function askForGeminiKey(ui) {
  for (;;) {
    const r = ui.prompt('Paste your Gemini API key',
      'Get one free at aistudio.google.com → Get API key → Create API key.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return '';
    const key = r.getResponseText().trim();
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) return key;
    ui.alert("That key didn't work",
      `Google replied with error ${res.getResponseCode()}. Check you copied the whole key, then try again.`,
      ui.ButtonSet.OK);
  }
}

// Asks for the /exec URL (with deploy steps) until a working one is pasted. '' on cancel.
function askForWebAppUrl(ui) {
  for (;;) {
    const r = ui.prompt('Last step: turn on your web app',
      '1. Extensions → Apps Script → Deploy → New deployment\n' +
      '2. Click ⚙️ next to "Select type" → Web app\n' +
      '3. Execute as: Me.  Who has access: Anyone\n' +
      '4. Deploy, copy the Web app URL (ends in /exec) and paste it here:', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return '';
    const url = r.getResponseText().trim();
    const problem = checkWebAppUrl(url);
    if (!problem) return url;
    ui.alert("That URL didn't work", problem, ui.ButtonSet.OK);
  }
}

// '' if the URL is this project's working web app, else what's wrong in plain words.
function checkWebAppUrl(url) {
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    return 'It should start with https://script.google.com/ and end with /exec.';
  }
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (err) { /* sign-in page or error page */ }
  if (body.status !== 'ok') {
    return 'Google showed a sign-in or error page instead. In Deploy → Manage deployments, check that ' +
           '"Who has access" is Anyone (not "Anyone with Google account").';
  }
  return '';
}

// Macro Logger → Show my Shortcut details: the URL + token to paste into the iPhone Shortcuts.
function showShortcutDetails() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEB_APP_URL');
  const token = props.getProperty('SHORTCUT_TOKEN');
  if (!url || !token) {
    ui.alert('Not set up yet', 'Click Macro Logger → Set up / repair first.', ui.ButtonSet.OK);
    return;
  }

  const links = SHORTCUT_LINKS.map(([name, link]) => link
    ? `<a href="${esc(link)}" target="_blank">${esc(name)}</a>`
    : `${esc(name)} (link in the README)`).join(' · ');
  const field = (id, label, value) => `
    <label for="${id}">${label}</label>
    <div class="row"><input id="${id}" readonly value="${esc(value)}">
    <button onclick="copy('${id}', this)">Copy</button></div>`;

  const html = `
    <style>
      body { font-family: Arial, sans-serif; font-size: 14px; color: #202124; }
      label { display: block; font-weight: bold; margin-top: 14px; }
      .row { display: flex; gap: 8px; margin-top: 4px; }
      input { flex: 1; padding: 6px; font-family: monospace; font-size: 13px; }
      button { padding: 6px 14px; }
      .warn { margin-top: 18px; color: #b3261e; }
    </style>
    <div>On your iPhone, open each Shortcut link and tap <b>Add Shortcut</b>. When it asks, paste these two:</div>
    ${field('url', 'Web app URL', url)}
    ${field('token', 'Token', token)}
    <p>Shortcuts: ${links}</p>
    <p>To get these onto your phone, send them to yourself in Notes or email, not in a group chat.</p>
    <p class="warn">Keep these private: anyone with both can add entries to your Sheet.</p>
    ${COPY_SCRIPT}`;
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(560).setHeight(380), 'Your Shortcut details');
}

// ── Update check ────────────────────────────────────────────

// Where updates come from. UPDATE_REPO / UPDATE_REF (Script Properties) are only for testing.
function updateSource() {
  const props = PropertiesService.getScriptProperties();
  return { repo: props.getProperty('UPDATE_REPO') || REPO, ref: props.getProperty('UPDATE_REF') || 'main' };
}

// The newest released version number, e.g. "1.1.0". Cached for 6 hours unless fresh = true.
function latestVersion(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const cached = cache.get('latest_version');
    if (cached) return cached;
  }
  const { repo, ref } = updateSource();
  const res = UrlFetchApp.fetch(`https://raw.githubusercontent.com/${repo}/${ref}/VERSION`, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`Couldn't check for updates (GitHub ${res.getResponseCode()})`);
  const v = res.getContentText().trim();
  cache.put('latest_version', v, 21600);
  return v;
}

// true if version a is newer than version b ("1.10.0" > "1.9.2")
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// One line for the Shortcut notification and the Daily tab; '' when up to date. Never throws.
function updateNotice() {
  try {
    const v = latestVersion(false);
    return isNewer(v, VERSION) ? `Update available: v${v}. Open your Sheet → Macro Logger → Check for updates` : '';
  } catch (err) {
    return '';
  }
}

// ── Guided update ───────────────────────────────────────────
// The script never changes its own code. It shows the new release and the steps to paste
// it in, so every update is a deliberate action by the owner of the copy.

// Macro Logger → Check for updates
function checkForUpdates() {
  const ui = SpreadsheetApp.getUi();
  const latest = latestVersion(true);
  if (!isNewer(latest, VERSION)) {
    ui.alert(`You're up to date (v${VERSION}).`);
    return;
  }

  const { repo } = updateSource();
  const res = UrlFetchApp.fetch(`https://raw.githubusercontent.com/${repo}/v${latest}/src/Code.js`, { muteHttpExceptions: true });
  const code = res.getContentText();
  if (res.getResponseCode() !== 200 || !code.includes(`const VERSION = '${latest}'`)) {
    ui.alert('Update not ready', `Couldn't download v${latest} yet. Try again later.`, ui.ButtonSet.OK);
    return;
  }

  const html = `
    <style>
      body { font-family: Arial, sans-serif; font-size: 14px; color: #202124; line-height: 1.45; }
      textarea { width: 100%; height: 90px; font-family: monospace; font-size: 11px; }
      button { padding: 6px 14px; margin: 6px 0; }
      li { margin-bottom: 6px; }
    </style>
    <div>You have v${esc(VERSION)}. <a href="https://github.com/${esc(repo)}/blob/main/CHANGELOG.md" target="_blank">What's new in v${esc(latest)}</a></div>
    <ol>
      <li><button onclick="copy('code', this)">Copy the new code</button></li>
      <li><b>Extensions → Apps Script</b>. In <code>Code.gs</code>, select everything (Ctrl/Cmd + A), paste, and click 💾 <b>Save</b>.</li>
      <li><b>Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.</b>
          Skip this and your Shortcuts keep running the old version.</li>
      <li>Reload this Sheet.</li>
    </ol>
    <div>Your meals, Settings, Targets, web app URL and token all stay the same. If the release notes
      say the <code>appsscript.json</code> file changed too, replace it the same way.</div>
    <textarea id="code" readonly>${esc(code)}</textarea>
    ${COPY_SCRIPT}`;
  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(620).setHeight(440), `Update to v${latest}`);
}

// ─────────────────────────────────────────────────────────────
// Targets: calorie calculator + red/green TOTAL rows
// ─────────────────────────────────────────────────────────────

const ACTIVITY_LEVELS = [
  ['Sedentary (little or no exercise)', 1.2],
  ['Light (exercise 1–3 days/week)', 1.375],
  ['Moderate (exercise 3–5 days/week)', 1.55],
  ['Active (exercise 6–7 days/week)', 1.725],
  ['Very active (hard daily training or physical job)', 1.9]
];
const GOALS = [['Weight Loss', -500], ['Maintenance', 0], ['Weight Gain', 500]];

// Builds the "Targets" tab, then recolours the Log. Run by Set up / repair; keeps your details (B2:B7).
function setupTargets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Targets');

  // Keep your own details if the tab already exists — only new tabs get the defaults.
  let saved = null;
  if (sheet && sheet.getRange('B2').getValue() !== '') {
    saved = sheet.getRange('B2:B7').getValues();
  }
  if (!sheet) sheet = ss.insertSheet('Targets');
  sheet.clear();

  const activitySwitch = ACTIVITY_LEVELS.map(([name, m]) => `"${name}", ${m}`).join(', ');
  const goalSwitch = GOALS.map(([name, adj]) => `"${name}", ${adj}`).join(', ');

  sheet.getRange('A1:B19').setValues([
    ['Your details', ''],
    ['Sex', 'Male'],                          // defaults for a brand-new tab —
    ['Age', 25],                              // edit these cells in the sheet,
    ['Weight (kg)', 70],                      // not here
    ['Height (cm)', 170],
    ['Activity level', ACTIVITY_LEVELS[2][0]],
    ['Goal', 'Maintenance'],
    ['', ''],
    ['How it\'s calculated', ''],
    ['BMR (Mifflin-St Jeor)', '=10*B4 + 6.25*B5 - 5*B3 + IF(B2="Male", 5, -161)'],
    ['Activity multiplier', `=SWITCH(B6, ${activitySwitch})`],
    ['Maintenance calories (TDEE)', '=B10*B11'],
    ['Goal adjustment (kcal)', `=SWITCH(B7, ${goalSwitch})`],
    ['', ''],
    ['Daily targets', ''],
    ['Calories (kcal)', '=ROUND(B12 + B13)'],   // B16
    ['Protein min (g)', '=ROUND(B4*1.2, 1)'],   // B17
    ['Protein max (g)', '=ROUND(B4*1.7, 1)'],   // B18
    ['Carbs (g) — 50% of kcal', '=ROUND(B16*0.5/4)'] // B19
  ]);
  sheet.getRange('A20:B20').setValues([['Fat (g) — 30% of kcal', '=ROUND(B16*0.3/9)']]); // B20
  if (saved) sheet.getRange('B2:B7').setValues(saved);

  // Dropdowns
  const list = vals => SpreadsheetApp.newDataValidation().requireValueInList(vals, true).build();
  sheet.getRange('B2').setDataValidation(list(['Male', 'Female']));
  sheet.getRange('B6').setDataValidation(list(ACTIVITY_LEVELS.map(a => a[0])));
  sheet.getRange('B7').setDataValidation(list(GOALS.map(g => g[0])));

  // Formatting
  ['A1', 'A9', 'A15'].forEach(c => sheet.getRange(c).setFontWeight('bold').setFontSize(12));
  sheet.getRange('B2:B7').setBackground('#fff8e1');            // editable inputs
  sheet.getRange('B10:B13').setFontColor('#666666');
  sheet.getRange('A16:B20').setFontWeight('bold').setBackground('#e8f0fe');
  sheet.getRange('B10').setNumberFormat('0');
  sheet.getRange('B12').setNumberFormat('0');
  sheet.setColumnWidth(1, 230);
  sheet.setColumnWidth(2, 320);

  rebuildLog();
}

// Colours each TOTAL row: green = target reached, red = not yet.
// Calories flip for Weight Loss (green when at or under target).
function applyTargetColors(sheet) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Targets')) return;

  const t = cell => `INDIRECT("Targets!${cell}")`;
  const green = (col, cond) => SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(`=AND($B2="TOTAL", ${cond})`)
    .setBackground('#b7e1cd').setFontColor('#0b5d1e')
    .setRanges([sheet.getRange(`${col}2:${col}`)])
    .build();

  const rules = [
    green('C', `IF(${t('B7')}="Weight Loss", C2<=${t('B16')}, C2>=${t('B16')})`),
    green('D', `D2>=${t('B17')}`),
    green('E', `E2>=${t('B19')}`),
    green('F', `F2>=${t('B20')}`),
    // Anything on a TOTAL row that didn't turn green turns red
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$B2="TOTAL"')
      .setBackground('#f4c7c3').setFontColor('#8c1d18')
      .setRanges([sheet.getRange('C2:F')])
      .build()
  ];
  sheet.setConditionalFormatRules(rules);
}

// ─────────────────────────────────────────────────────────────
// Weight tracking
// ─────────────────────────────────────────────────────────────

const WEIGHT_SHEET = 'Weight';

function getWeightSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(WEIGHT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(WEIGHT_SHEET);
    sheet.appendRow(['Date', 'Weight (kg)', '7-day avg (kg)', 'Change since start (kg)']);
    sheet.getRange('A1:D1').setFontWeight('bold').setBackground('#e8f0fe');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(4, 180);

    // Line chart of daily weight + 7-day average
    sheet.insertChart(sheet.newChart().asLineChart()
      .addRange(sheet.getRange('A1:C1000'))
      .setNumHeaders(1)
      .setPosition(2, 6, 0, 0)
      .setOption('title', 'Weight (kg)')
      .setOption('width', 600)
      .setOption('height', 350)
      .build());
  }
  return sheet;
}

// Zooms the weight chart to your own range (e.g. 68–74 kg) instead of starting at 0 kg,
// so small changes are visible. Runs after every weight log.
function fitWeightChart(sheet) {
  const chart = sheet.getCharts()[0];
  if (!chart || sheet.getLastRow() < 2) return;
  const kgs = sheet.getRange(2, 2, sheet.getLastRow() - 1, 2).getValues().flat()
    .map(Number).filter(n => n > 0);
  if (!kgs.length) return;
  const min = Math.floor(Math.min(...kgs) - 1);
  const max = Math.ceil(Math.max(...kgs) + 1);
  sheet.updateChart(chart.modify()
    .setOption('vAxes', { 0: { viewWindow: { min, max } } })
    .build());
}

// One row per day; logging again on the same day overwrites that day's entry.
function logWeight(raw) {
  const kg = Math.round(parseFloat(String(raw).replace(',', '.')) * 10) / 10;
  if (!(kg > 20 && kg < 300)) throw new Error(`"${raw}" doesn't look like a weight in kg`);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = getWeightSheet();
    const dayKey = d => Utilities.formatDate(d, getSettings().time_zone, 'yyyy-MM-dd');

    const last = sheet.getLastRow();
    let row = last + 1;
    if (last >= 2) {
      const lastDate = sheet.getRange(last, 1).getValue();
      if (lastDate instanceof Date && dayKey(lastDate) === dayKey(new Date())) row = last;
    }

    sheet.getRange(row, 1, 1, 2).setValues([[new Date(), kg]]);
    sheet.getRange(row, 3).setFormula(
      `=ROUND(AVERAGEIFS(B:B, A:A, ">="&(INT(A${row})-6), A:A, "<"&(INT(A${row})+1)), 1)`);
    sheet.getRange(row, 4).setFormula(`=ROUND(B${row}-$B$2, 1)`);
    sheet.getRange(row, 1).setNumberFormat('ddd, d mmm yyyy');
    sheet.getRange(row, 2, 1, 3).setNumberFormat('0.0');

    if (getSettings().sync_weight_to_targets) {
      const targets = ss.getSheetByName('Targets');
      if (targets) targets.getRange('B4').setValue(kg);
    }

    SpreadsheetApp.flush();
    fitWeightChart(sheet);
    return {
      status: 'ok',
      weight_kg: kg,
      avg7_kg: sheet.getRange(row, 3).getValue(),
      change_kg: sheet.getRange(row, 4).getValue()
    };
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────
// Foods database: frequent foods get baseline macros automatically
// ─────────────────────────────────────────────────────────────
//
// • Every photo log gets a Food ID from Gemini (e.g. roasted_chicken_rice).
// • Once an ID has been photo-logged FREQUENT_THRESHOLD times, it's added to the Foods tab
//   with the MEDIAN of those logs as its macros (median ignores one-off bad estimates).
// • The baseline keeps updating as you log more. To lock in your own numbers
//   (e.g. from a nutrition label), edit the row and set Source to "Verified".
// • You can also add rows by hand — set Source to "Verified" and the ID is optional.

const FOODS_SHEET = 'Foods';
const FREQUENT_THRESHOLD = 3;
const FOODS_HEADER = ['Food ID', 'Name', 'Kcal', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Times logged', 'Source', 'Last eaten'];

function getFoodsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(FOODS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(FOODS_SHEET);
    sheet.getRange(1, 1, 1, FOODS_HEADER.length).setValues([FOODS_HEADER])
      .setFontWeight('bold').setBackground('#e8f0fe');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(2, 240);
  }
  return sheet;
}

const median = arr => {
  const a = arr.map(Number).filter(n => !isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return Math.round(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2);
};

const slug = s => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// Rebuilds the Foods tab from the Log. Runs after every log; safe to run by hand.
function updateFoods() {
  const log = getLogSheet();
  const foods = getFoodsSheet();
  if (log.getLastRow() < 2) return;

  // Group Log meals by Food ID
  const groups = {};
  log.getRange(2, 1, log.getLastRow() - 1, LOG_COLS).getValues().forEach(r => {
    const id = String(r[8] || '').trim();
    if (!(r[0] instanceof Date) || r[1] === 'TOTAL' || !id) return;
    (groups[id] = groups[id] || []).push(r);
  });

  // Existing Foods rows, keyed by ID
  const existing = foods.getLastRow() > 1
    ? foods.getRange(2, 1, foods.getLastRow() - 1, FOODS_HEADER.length).getValues().filter(r => r[0] || r[1])
    : [];
  const byId = {};
  existing.forEach(r => {
    if (!r[0]) r[0] = slug(r[1]);           // hand-added rows without an ID
    byId[r[0]] = r;
  });

  Object.keys(groups).forEach(id => {
    const all = groups[id].sort((a, b) => a[0] - b[0]);
    const photoLogs = all.filter(r => r[6] !== 'db');   // quick logs don't affect the baseline
    const lastEaten = all[all.length - 1][0];
    const row = byId[id];

    if (row && row[7] === 'Verified') {
      row[6] = all.length;
      row[8] = lastEaten;
    } else if (photoLogs.length >= FREQUENT_THRESHOLD) {
      byId[id] = [
        id,
        (row && row[1]) || photoLogs[photoLogs.length - 1][1],
        median(photoLogs.map(r => r[2])),
        median(photoLogs.map(r => r[3])),
        median(photoLogs.map(r => r[4])),
        median(photoLogs.map(r => r[5])),
        all.length,
        `Auto (median of ${photoLogs.length})`,
        lastEaten
      ];
    } else if (row) {
      row[6] = all.length;
      row[8] = lastEaten;
    }
  });

  const out = Object.values(byId).sort((a, b) => (Number(b[6]) || 0) - (Number(a[6]) || 0));
  if (foods.getLastRow() > 1) foods.getRange(2, 1, foods.getLastRow() - 1, FOODS_HEADER.length).clearContent();
  if (!out.length) return;
  foods.getRange(2, 1, out.length, FOODS_HEADER.length).setValues(out);
  foods.getRange(2, 9, out.length, 1).setNumberFormat('d mmm yyyy');
}

// IDs Gemini should reuse: everything in Foods plus recent Log IDs.
function knownFoodIds() {
  const ids = new Set();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const foods = ss.getSheetByName(FOODS_SHEET);
  if (foods && foods.getLastRow() > 1) {
    foods.getRange(2, 1, foods.getLastRow() - 1, 1).getValues().forEach(r => r[0] && ids.add(r[0]));
  }
  const log = ss.getSheetByName(SHEET_NAME);
  if (log && log.getLastRow() > 1) {
    const n = Math.min(log.getLastRow() - 1, 300);
    log.getRange(log.getLastRow() - n + 1, 9, n, 1).getValues().forEach(r => r[0] && ids.add(r[0]));
  }
  return [...ids].slice(0, 100);
}

// Foods with macros, most-eaten first. Labels are what the Shortcut shows in its list.
function foodList() {
  const foods = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FOODS_SHEET);
  if (!foods || foods.getLastRow() < 2) return [];
  return foods.getRange(2, 1, foods.getLastRow() - 1, FOODS_HEADER.length).getValues()
    .filter(r => r[1] && r[2] !== '')
    .sort((a, b) => (Number(b[6]) || 0) - (Number(a[6]) || 0))
    .map(r => ({
      id: r[0] || slug(r[1]), name: r[1],
      kcal: Number(r[2]), protein_g: Number(r[3]), carbs_g: Number(r[4]), fat_g: Number(r[5]),
      label: `${r[1]} · ${Math.round(r[2])} kcal`
    }));
}

// Logs a saved food without a photo. `food` can be the list label, the name, or the ID.
function quickLog(food, servings) {
  const s = servings === undefined || servings === '' ? 1 : parseFloat(String(servings).replace(',', '.'));
  if (!(s > 0 && s <= 10)) throw new Error(`"${servings}" isn't a valid number of servings`);

  const key = String(food || '').trim().toLowerCase();
  const f = foodList().find(x => x.label.toLowerCase() === key || x.name.toLowerCase() === key || x.id === key);
  if (!f) throw new Error(`"${food}" isn't in your Foods tab`);

  const m = {
    food: s === 1 ? f.name : `${f.name} ×${s}`,
    kcal: Math.round(f.kcal * s), protein_g: Math.round(f.protein_g * s),
    carbs_g: Math.round(f.carbs_g * s), fat_g: Math.round(f.fat_g * s)
  };
  addMealRow([new Date(), m.food, m.kcal, m.protein_g, m.carbs_g, m.fat_g, 'db',
              `quick log · ${s} serving${s === 1 ? '' : 's'}`, f.id]);
  return m;
}

// ─────────────────────────────────────────────────────────────
// Next-meal suggestions
// ─────────────────────────────────────────────────────────────


// Works out what's left for today, asks Gemini for 3 ideas based on foods you actually eat,
// writes them to the Daily tab, and returns a one-line summary for the notification.
function suggestNextMeal(apiKey) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const targets = ss.getSheetByName('Targets');
  if (!targets) return '';

  const [kcalT, proteinMin, , carbsT, fatT] = targets.getRange('B16:B20').getValues().map(r => Number(r[0]) || 0);
  const goal = targets.getRange('B7').getValue();
  const t = todayTotals();
  const left = {
    kcal: Math.round(kcalT - t.today_kcal),
    protein_g: Math.round(proteinMin - t.today_protein_g),
    carbs_g: Math.round(carbsT - t.today_carbs_g),
    fat_g: Math.round(fatT - t.today_fat_g)
  };
  const settings = getSettings();
  const time = Utilities.formatDate(new Date(), settings.time_zone, 'h:mm a');

  if (left.kcal <= 50 && left.protein_g <= 5) {
    writeSuggestions(left, [], time);
    return goal === 'Weight Loss' ? 'Calorie budget used up for today' : 'Targets hit for today 🎉';
  }

  const prompt = `You suggest what ${settings.about_me} should eat next.

Goal: ${goal}. Local time: ${time}.
Remaining for today: ${left.kcal} kcal, ${left.protein_g} g protein, ${left.carbs_g} g carbs, ${left.fat_g} g fat.
(Negative means already over.)

Foods this person actually eats (typical portion):
${usualFoods().join('\n') || '(no history yet)'}

Suggest exactly 3 options, best first:
- Prefer foods from the list above (combinations are fine, e.g. a meal plus a drink).
  You may add common everyday options (${settings.usual_food}, convenience-store food) if the list doesn't fit.
- Prioritise whichever macro is furthest behind, usually protein.
- ${goal === 'Weight Loss'
    ? 'Stay within the remaining calories.'
    : 'Aim to get close to the remaining calories without going far over.'}
- Match the time: a proper meal at meal times, lighter options late at night.
- If very little is left, suggest a small snack.
Keep "meal" under 8 words and "reason" under 12 words.`;

  const r = callGemini(settings.suggest_models, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          suggestions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                meal:      { type: 'STRING' },
                kcal:      { type: 'NUMBER' },
                protein_g: { type: 'NUMBER' },
                reason:    { type: 'STRING' }
              },
              required: ['meal', 'kcal', 'protein_g', 'reason']
            }
          }
        },
        required: ['suggestions']
      }
    }
  }, apiKey);

  const s = (r.suggestions || []).slice(0, 3).map(x => Object.assign(x, {
    kcal: Math.round(x.kcal), protein_g: Math.round(x.protein_g)
  }));
  writeSuggestions(left, s, time);

  if (!s.length) return '';
  return `Left: ${left.kcal} kcal, ${left.protein_g}g P → try ${s[0].meal} (~${s[0].kcal} kcal, ${s[0].protein_g}g P)`;
}

// Your most-eaten foods from the Log, with typical kcal/protein per portion.
function usualFoods() {
  const log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!log || log.getLastRow() < 2) return [];
  const n = Math.min(log.getLastRow() - 1, 300);
  const groups = {};
  log.getRange(log.getLastRow() - n + 1, 1, n, LOG_COLS).getValues().forEach(r => {
    if (!(r[0] instanceof Date) || r[1] === 'TOTAL') return;
    const key = String(r[8] || '') || slug(r[1]);
    (groups[key] = groups[key] || []).push(r);
  });
  return Object.values(groups)
    .sort((a, b) => b.length - a.length)
    .slice(0, 25)
    .map(rows => `- ${rows[rows.length - 1][1]} (~${median(rows.map(r => r[2]))} kcal, ` +
                 `${median(rows.map(r => r[3]))}g protein, eaten ${rows.length}x)`);
}

// Shows the latest suggestions on the Daily tab (if it exists), all in one wrapped cell (G3):
//   1. Grilled chicken + boiled egg
//      ~250 kcal · 35 g protein
//      Tops up protein without many calories
function writeSuggestions(left, suggestions, time) {
  const daily = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Daily');
  if (!daily) return;

  daily.getRange('G1:H8').clear(); // also removes the older multi-row layout
  daily.getRange('G1').setValue('What to eat next').setFontWeight('bold').setBackground('#e8f0fe');
  daily.getRange('G2').setValue(
    `Left today: ${left.kcal} kcal · ${left.protein_g}g protein · ${left.carbs_g}g carbs · ${left.fat_g}g fat`
  ).setFontWeight('bold');

  const text = suggestions.length
    ? suggestions.map((x, i) =>
        `${i + 1}. ${x.meal}\n     ~${x.kcal} kcal · ${x.protein_g} g protein\n     ${x.reason}`
      ).join('\n\n')
    : 'Targets hit for today 🎉';
  daily.getRange('G3').setValue(text).setWrap(true).setVerticalAlignment('top');

  daily.getRange('G4').setValue(`Updated ${time}`).setFontColor('#888888');
  const notice = updateNotice();
  daily.getRange('G5').setValue(notice).setFontColor('#b3261e').setFontWeight(notice ? 'bold' : 'normal');
  daily.setColumnWidth(7, 420);
  daily.autoResizeRows(3, 1);
}

// Macro Logger → Refresh suggestions: updates the Daily tab suggestions without logging a meal.
function refreshSuggestions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Targets') || !ss.getSheetByName('Daily')) {
    throw new Error('Missing the Targets or Daily tab: click Macro Logger → Set up / repair first');
  }
  const s = suggestNextMeal(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'));
  ss.toast(s || 'Suggestions refreshed', 'Macro Logger');
}