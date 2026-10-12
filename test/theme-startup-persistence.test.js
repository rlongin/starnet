'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');
// Execute the actual startup and save functions in fresh JS sessions sharing only storage.
const start = source.slice(source.indexOf('  function notifyDefaults()'), source.indexOf('  const uid ='));
const themes = source.match(/const THEMES = [^\n]+/)[0];
const primaryKey = source.match(/const KEY = '([^']+)'/)[1];
const defaults = source.match(/  function defaults\(\) \{[^\n]+/)[0];
const storage = new Map();
function boot() {
  const context = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) }, notify() {} };
  vm.createContext(context);
  vm.runInContext("const KEY = " + JSON.stringify(primaryKey) + "; const THEME_KEY = 'starnet.appearance.theme.v1'; const SETTINGS_KEY = 'starnet.appearance.settings.v1';\n" + themes + '\n' + defaults + '\n' + start + '\nglobalThis.session = { store, save };', context);
  return context.session;
}
let first = boot();
Object.assign(first.store.settings, { theme: 'custom', themeHue: 210, themeSat: 72, themeGlow: 125, sound: false, textScale: 2, backdrop: 'stars' });
first.store.settings.notifyPrefs.sound = false;
assert.equal(first.save(), true);
let reopened = boot();
for (const [key, value] of Object.entries({ theme: 'custom', themeHue: 210, themeSat: 72, themeGlow: 125, sound: false, textScale: 2, backdrop: 'stars' })) assert.equal(reopened.store.settings[key], value);
assert.equal(reopened.store.settings.notifyPrefs.sound, false);
storage.delete(primaryKey);
reopened = boot(); assert.equal(reopened.store.settings.themeHue, 210); assert.equal(reopened.store.settings.sound, false);
storage.set(primaryKey, '{broken');
reopened = boot(); assert.equal(reopened.store.settings.theme, 'custom'); assert.equal(reopened.store.settings.themeSat, 72);
storage.clear(); storage.set('starnet.appearance.theme.v1', 'purple');
reopened = boot(); assert.equal(reopened.store.settings.theme, 'purple');
storage.clear(); storage.set('starnet.appearance.theme.v1', 'invalid');
reopened = boot(); assert.equal(reopened.store.settings.theme, 'amber');
console.log('PASS: fresh sessions retain custom color, preferences, notifications; recover missing/corrupt station snapshot; migrate legacy theme; reject invalid theme.');
