/* harness.js — run a single-file browser app's JavaScript inside Node, with a fake DOM. */
const fs = require('fs');
const vm = require('vm');

function boot(htmlPath, opts) {
  opts = opts || {};
  const html = fs.readFileSync(htmlPath, 'utf8');

  const blocks = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  if (!blocks.length) throw new Error('No inline <script> blocks found in ' + htmlPath);

  const store = {};
  const els = {};
  const log = { alerts: [], confirms: [], downloads: [], opened: [] };

  function makeEl(sel) {
    if (els[sel]) return els[sel];
    return (els[sel] = {
      innerHTML: '', outerHTML: '', value: '', textContent: '', src: '', href: '', download: '',
      style: {}, dataset: {}, files: null, checked: false, disabled: false, scrollTop: 0,
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
      remove() {}, click() {}, select() {}, focus() {}, blur() {}, submit() {},
      setAttribute() {}, getAttribute() { return null; }, insertAdjacentHTML() {},
      getContext() { return { drawImage() {}, fillRect() {}, clearRect() {}, fillText() {} }; },
      toDataURL() { return 'data:image/jpeg;base64,TEST'; },
      querySelector(s) { return makeEl(sel + ' ' + s); },
      querySelectorAll() { return []; },
      closest() { return null; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 320, height: 480 }; }
    });
  }

  const doc = {
    querySelector: (s) => makeEl(s),
    querySelectorAll: () => [],
    getElementById: (id) => makeEl('#' + id),
    createElement: () => makeEl('__tmp' + Math.random()),
    createDocumentFragment: () => makeEl('__frag' + Math.random()),
    addEventListener() {}, removeEventListener() {},
    execCommand() { return true; },
    body: { appendChild() {}, dataset: {}, classList: { add() {}, remove() {} } },
    activeElement: null,
    documentElement: { style: {} },
    head: { appendChild() {} },
    readyState: 'complete'
  };

  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Date, Math, JSON, Promise, Number, String, Array, Object, Boolean, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, btoa, atob,
    document: doc,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { for (const k in store) delete store[k]; },
      key: (i) => Object.keys(store)[i] || null,
      get length() { return Object.keys(store).length; }
    },
    sessionStorage: null,
    navigator: { clipboard: null, userAgent: 'node-harness' },
    isSecureContext: false,
    location: { href: 'http://localhost/index.html', protocol: 'http:', reload() {} },
    URL: { createObjectURL: () => 'blob:harness/' + Math.random(), revokeObjectURL() {} },
    Blob: class { constructor(p) { this.parts = p; this.size = String(p && p[0] || '').length; } },
    File: class {},
    FileReader: class { readAsText() {} readAsDataURL() {} },
    FormData: class { constructor() { this._d = {}; } get(k) { return this._d[k]; } set(k, v) { this._d[k] = v; } },
    Image: class {},
    alert: (msg) => { log.alerts.push(String(msg)); },
    confirm: (msg) => { log.confirms.push(String(msg)); return opts.confirm === undefined ? true : opts.confirm; },
    prompt: () => null,
    fetch: () => Promise.reject(new Error('offline in harness')),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    matchMedia: () => ({ matches: false, addEventListener() {} })
  };
  if (opts.indexedDB) {
    ctx.indexedDB = { open: () => { const r = {}; setTimeout(() => r.onerror && r.onerror(), 0); return r; } };
  }
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.window.addEventListener = () => {};
  ctx.window.removeEventListener = () => {};
  ctx.window.scrollTo = () => {};
  ctx.window.matchMedia = ctx.matchMedia;
  Object.assign(ctx, opts.globals || {});

  vm.createContext(ctx);

  blocks.forEach((code, i) => {
    try {
      vm.runInContext(code, ctx, { filename: 'inline-script-' + i + '.js' });
    } catch (e) {
      console.error('\n✗ inline <script> block #' + i + ' threw on load: ' + e.message);
      console.error(e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : '');
      process.exit(1);
    }
  });

  ctx.__t = { pass: 0, fail: 0, failures: [] };
  ctx.ok = function (cond, label) {
    if (cond) { ctx.__t.pass++; console.log('  ✓ ' + label); }
    else { ctx.__t.fail++; ctx.__t.failures.push(label); console.log('  ✗ FAIL: ' + label); }
  };
  ctx.html = (sel) => makeEl(sel).innerHTML;
  ctx.section = (name) => console.log('\n[' + name + ']');
  ctx.harnessLog = log;

  return {
    ctx, els, log,
    html: (sel) => makeEl(sel).innerHTML,
    run(code, label) {
      try { vm.runInContext(code, ctx, { filename: (label || 'assertions') + '.js' }); }
      catch (e) {
        ctx.__t.fail++;
        ctx.__t.failures.push('threw: ' + e.message);
        console.log('  ✗ FAIL (threw): ' + e.message);
      }
      return this;
    },
    done() {
      const t = ctx.__t;
      console.log('\n' + '='.repeat(40));
      console.log(t.pass + ' passed, ' + t.fail + ' failed');
      console.log('='.repeat(40));
      if (t.fail) { console.log('\nFailures:'); t.failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
      return t;
    }
  };
}

module.exports = { boot };
