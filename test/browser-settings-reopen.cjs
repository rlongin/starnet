const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const source = fs.readFileSync('frontend/app/stationui.js', 'utf8');
const start = source.slice(source.indexOf('  function notifyDefaults()'), source.indexOf('  const uid ='));
const themes = source.match(/const THEMES = [^\n]+/)[0];
const primaryKey = source.match(/const KEY = '([^']+)'/)[1];
const defaults = source.match(/  function defaults\(\) \{[^\n]+/)[0];
const code = "const KEY=" + JSON.stringify(primaryKey) + ", THEME_KEY='starnet.appearance.theme.v1', SETTINGS_KEY='starnet.appearance.settings.v1';\n" + themes + '\n' + defaults + '\n' + start + '\nwindow.session={store,save};';
(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><body><script>' + code + '</script>'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  const profile = fs.mkdtempSync('/tmp/council-settings-test-');
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profile, { headless: true });
    let page = await browser.newPage(); await page.goto(url);
    await page.evaluate(() => { Object.assign(session.store.settings, { theme: 'custom', themeHue: 195, themeSat: 64, themeGlow: 130, sound: false, textScale: 2 }); if (!session.save()) throw Error('save failed'); });
    await page.close(); page = await browser.newPage(); await page.goto(url);
    assert.equal(await page.evaluate(() => session.store.settings.themeHue), 195);
    await browser.close(); browser = null;
    browser = await chromium.launchPersistentContext(profile, { headless: true });
    page = await browser.newPage(); await page.goto(url);
    assert.deepEqual(await page.evaluate(() => { const s=session.store.settings; return [s.theme,s.themeHue,s.themeSat,s.themeGlow,s.sound,s.textScale]; }), ['custom',195,64,130,false,2]);
    await page.evaluate(key => localStorage.setItem(key, '{corrupt'), primaryKey);
    await page.reload(); assert.equal(await page.evaluate(() => session.store.settings.themeSat),64);
    console.log('PASS real Chromium localStorage: tab close/reopen, full browser process close/relaunch, corrupt snapshot recovery; full custom colors and preferences retained.');
  } finally { if (browser) await browser.close(); await new Promise(r=>server.close(r)); fs.rmSync(profile,{recursive:true,force:true}); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
