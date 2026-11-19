const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { ZOOM_MIN, ZOOM_MAX, zoomActionForInput, nextZoomLevel, attachZoom } = require('../zoom');

const key = (extra) => ({ type: 'keyDown', control: true, alt: false, meta: false, ...extra });

test('Ctrl + = / - / 0 map to zoom in, out and reset; other keys are ignored', () => {
  assert.equal(zoomActionForInput(key({ key: '=' })), 'in');
  assert.equal(zoomActionForInput(key({ key: '+' })), 'in');
  assert.equal(zoomActionForInput(key({ key: '-' })), 'out');
  assert.equal(zoomActionForInput(key({ key: '0' })), 'reset');
  assert.equal(zoomActionForInput(key({ key: 'Unidentified', code: 'NumpadAdd' })), 'in');
  assert.equal(zoomActionForInput(key({ key: '=', control: false })), null);
  assert.equal(zoomActionForInput(key({ key: '=', alt: true })), null);
  assert.equal(zoomActionForInput(key({ key: '=', type: 'keyUp' })), null);
  assert.equal(zoomActionForInput(key({ key: 'c' })), null);
});

test('zoom levels step by half and stay within limits', () => {
  assert.equal(nextZoomLevel(0, 'in'), 0.5);
  assert.equal(nextZoomLevel(0, 'out'), -0.5);
  assert.equal(nextZoomLevel(2, 'reset'), 0);
  assert.equal(nextZoomLevel(ZOOM_MAX, 'in'), ZOOM_MAX);
  assert.equal(nextZoomLevel(ZOOM_MIN, 'out'), ZOOM_MIN);
});

test('wheel zoom and shortcuts change the window zoom level', () => {
  const contents = new EventEmitter();
  let level = 0;
  contents.getZoomLevel = () => level;
  contents.setZoomLevel = value => { level = value; };
  attachZoom(contents);

  contents.emit('zoom-changed', {}, 'in');
  contents.emit('zoom-changed', {}, 'in');
  assert.equal(level, 1);
  let prevented = false;
  contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, key({ key: '-' }));
  assert.equal(level, 0.5);
  assert.equal(prevented, true);
  contents.emit('before-input-event', { preventDefault() {} }, key({ key: '0' }));
  assert.equal(level, 0);
  prevented = false;
  contents.emit('before-input-event', { preventDefault: () => { prevented = true; } }, key({ key: 'a' }));
  assert.equal(prevented, false, 'ordinary shortcuts pass through');
});

test('the main window uses zoom and the module is packaged', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.match(main, /attachZoom\(mainWindow\.webContents\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('zoom.js'));
});
