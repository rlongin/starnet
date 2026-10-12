'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');

assert.match(source, /const THEME_KEY = 'starnet\.appearance\.theme\.v1'/);
assert.match(source, /localStorage\.getItem\(THEME_KEY\)/);
assert.match(source, /THEMES\.some\(\(\[name\]\) => name === savedTheme\)/);
assert.match(source, /store\.settings\.theme = savedTheme/);
assert.match(source, /localStorage\.setItem\(THEME_KEY, store\.settings\.theme\)/);
assert.match(source, /function setTheme\(t\)/);
console.log('Council theme persistence source contract passed');
