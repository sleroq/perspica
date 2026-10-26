// Run with: node --test crates/perspica-cli/tests/motion.mjs
// Requires agent-browser and Chrome; no npm dependencies or live model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const web = new URL('../web/', import.meta.url);
const manifest = { renames: [], signature_changes: [], extracted_functions: [], moved_code: [], dependency_changes: [], dead_code: [], formatting_only: [], test_entries: [], logic_changes: [] };
const data = {
    version: '0.3.0', source: { label: 'Motion regression', sessions: { sessions: [], requirements: [{ id: 'R1', text: 'Keep navigation accessible.' }] } },
    files: [{ old_path: 'file.ts', new_path: 'file.ts', old_source: 'old\nold', new_source: 'new\nnew', language: 'TypeScript', status: 'M', binary: false }],
    results: [{ manifest, review: { changed_lines: 2, mechanical_lines: 0, parsed: true, generated: false, role: 'source', test_lines: 0 }, hunks: [1, 2].map(line => ({ old_range: { start: line, end: line }, new_range: { start: line, end: line }, manifest_refs: [], changes: [{ kind: 'added', content_new: 'new', new_span: { start_line: line, end_line: line, start_col: 0, end_col: 3 } }] })) }],
    concerns: [],
};

test('animation preference in the real viewer', async t => {
    const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'favicon.svg'].map(async name => [name, await readFile(new URL(name, web), 'utf8')])));
    assets.set('index.html', assets.get('index.html').replace(/<script src="https:[^>]+><\/script>/g, ''));
    const server = createServer((req, res) => {
        if (req.url === '/api/diff') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return; }
        const name = req.url === '/' ? 'index.html' : req.url.slice(1);
        if (!assets.has(name)) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(assets.get(name));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const session = `motion-${process.pid}`;
    async function browser(...args) {
        const { stdout } = await exec('agent-browser', ['--session', session, '--json', ...args], { timeout: 30000 });
        return JSON.parse(stdout).data;
    }
    async function evaluate(fn) {
        return (await browser('eval', '-b', Buffer.from(`(${fn})()`).toString('base64'))).result;
    }
    async function reload() {
        await browser('reload');
        await browser('wait', '#h-0-0');
    }
    t.after(async () => { await browser('close'); await new Promise(resolve => server.close(resolve)); });
    await browser('open', `http://127.0.0.1:${server.address().port}/`);
    await browser('wait', '#h-0-0');
    await evaluate(() => localStorage.removeItem('perspica:animations'));
    await browser('set', 'media', 'light');
    await reload();

    await t.test('system default updates live without persisting a choice', async () => {
        assert.deepEqual(await evaluate(() => [animationsEnabled(), document.getElementById('animations-toggle').checked, localStorage.getItem('perspica:animations')]), [true, true, null]);
        await browser('set', 'media', 'light', 'reduced-motion');
        await browser('wait', '--fn', 'document.documentElement.dataset.animations === "false"');
        assert.deepEqual(await evaluate(() => [animationsEnabled(), document.getElementById('animations-toggle').checked, scrollBehavior(), localStorage.getItem('perspica:animations')]), [false, false, 'auto', null]);
        await evaluate(() => localStorage.setItem('perspica:animations', '"true"'));
        await reload();
        assert.equal(await evaluate(() => animationsEnabled()), false, 'non-boolean saved values do not override reduced motion');
    });

    await t.test('explicit on overrides reduced motion and survives reload', async () => {
        await browser('click', '#view-btn');
        await browser('check', '#animations-toggle');
        assert.deepEqual(await evaluate(() => [animationsEnabled(), scrollBehavior(), localStorage.getItem('perspica:animations'), getComputedStyle(document.querySelector('#view-btn .caret')).transitionDuration]), [true, 'smooth', 'true', '0.12s']);
        await reload();
        assert.deepEqual(await evaluate(() => [animationsEnabled(), document.getElementById('animations-toggle').checked]), [true, true]);
    });

    await t.test('keyboard jumps stay instant while pointer jumps may animate', async () => {
        assert.deepEqual(await evaluate(() => {
            const calls = [];
            const original = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function (opts) { calls.push(opts.behavior); };
            try {
                document.getElementById('next-change').click();
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
                // Sandboxed lessons forward shortcuts with document as the event target.
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
            } finally { Element.prototype.scrollIntoView = original; }
            return calls;
        }), ['smooth', 'auto', 'auto']);
    });

    await t.test('off disables CSS including pseudo-elements and every navigation jump', async () => {
        await browser('click', '#view-btn');
        await browser('uncheck', '#animations-toggle');
        await browser('set', 'media', 'light');
        await reload();
        assert.deepEqual(await evaluate(() => {
            const badge = document.getElementById('learn-badge');
            badge.classList.add('busy');
            document.documentElement.style.scrollBehavior = 'smooth';
            const css = document.createElement('style');
            css.textContent = '.motion-probe { animation: spin 1s infinite; transition: transform 1s; scroll-behavior: smooth }';
            document.head.append(css);
            const probe = document.createElement('div'); probe.className = 'motion-probe'; document.body.append(probe);
            return [animationsEnabled(), document.getElementById('animations-toggle').checked, localStorage.getItem('perspica:animations'), getComputedStyle(probe).animationName, getComputedStyle(probe).transitionDuration, getComputedStyle(probe).scrollBehavior, getComputedStyle(badge, '::before').animationName, getComputedStyle(document.documentElement).scrollBehavior];
        }), [false, false, 'false', 'none', '0s', 'auto', 'none', 'auto']);
        assert.deepEqual(await evaluate(() => {
            const calls = [];
            const original = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function (opts) { calls.push(opts.behavior || 'auto'); };
            try {
                jumpToFile(0);
                revealHunk(0, 0);
                document.getElementById('next-change').click();
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
                const req = document.createElement('button'); req.dataset.req = 'R1'; document.body.append(req); req.click(); req.remove();
            } finally { Element.prototype.scrollIntoView = original; }
            return calls;
        }), ['auto', 'auto', 'auto', 'auto', 'auto']);
    });

    await t.test('sandboxed lesson CSS follows the preference without reloading', async () => {
        await evaluate(() => {
            window.motionFrameReports = [];
            window.addEventListener('message', e => { if (e.data?.motionProbe) motionFrameReports.push(e.data.motionProbe); });
            const f = document.createElement('iframe'); f.className = 'learn-frame'; f.sandbox = 'allow-scripts';
            f.srcdoc = frameDoc(`<style>#probe{transition:transform 1s;animation:spin 1s infinite}@keyframes spin{to{transform:rotate(360deg)}}</style><div id="probe">Probe</div><script>let reports=0;const report=()=>{const s=getComputedStyle(document.getElementById('probe'));parent.postMessage({motionProbe:[++reports,s.transitionDuration,s.animationName]},'*')};addEventListener('load',report);addEventListener('message',()=>setTimeout(report,0));<\/script>`);
            document.body.append(f);
        });
        await browser('wait', '--fn', 'motionFrameReports.length === 1');
        assert.deepEqual(await evaluate(() => motionFrameReports.at(-1)), [1, '0s', 'none']);
        await evaluate(() => setAnimations(true));
        await browser('wait', '--fn', 'motionFrameReports.length === 2');
        assert.deepEqual(await evaluate(() => motionFrameReports.at(-1)), [2, '1s', 'spin']);
        await evaluate(() => setAnimations(false));
        await browser('wait', '--fn', 'motionFrameReports.length === 3');
        assert.deepEqual(await evaluate(() => motionFrameReports.at(-1)), [3, '0s', 'none']);
    });
});
