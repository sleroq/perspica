// Run with: node --test crates/perspica-cli/tests/fold_calls.mjs
// Requires agent-browser and Chrome; no npm dependencies or live model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const web = new URL('../web/', import.meta.url);

function fixture() {
    const steps = [
        ['Data', 0, 'type'], ['main', 0], ['parse', 1], ['tokenize', 2],
        ['save', 1], ['standalone', 0], ['main', 0], ['finish', 1], ['LIMIT', 0, 'other'],
    ].map(([name, depth, kind = 'function'], i) => ({
        name, depth, kind, file: 'flow.ts', entry_ids: [i + 1], called_by: [], calls: [],
    }));

    // Give every step its own hunk so navigation can select each tree level.
    const source = steps.map(s => `function ${s.name}() { return 1; }`).join('\n');
    function span(line) { return { start_line: line, end_line: line, start_col: 0, end_col: 1 }; }
    function hunk(id, line = id) {
        return {
            old_range: { start: line, end: line }, new_range: { start: line, end: line },
            manifest_refs: id ? [id] : [],
            changes: [
                { kind: 'removed', content_old: 'return 0;', old_span: span(line) },
                { kind: 'added', content_new: 'return 1;', new_span: span(line) },
            ],
        };
    }

    const manifest = {
        renames: [], signature_changes: [], extracted_functions: [], moved_code: [],
        dependency_changes: [], dead_code: [], formatting_only: [], test_entries: [],
        logic_changes: steps.map((s, i) => ({
            id: i + 1, name: s.name, description: 'body modified',
            location: { file: s.file, line_start: i + 1, line_end: i + 1, side: 'new' },
        })),
    };

    // Unclassified hunks exercise the non-call sections after the function tree.
    function file(path) { return { old_path: path, new_path: path, old_source: source, new_source: source, language: 'TypeScript', status: 'M', binary: false }; }
    const review = { changed_lines: 18, mechanical_lines: 0, parsed: true, generated: false, role: 'source', test_lines: 0 };
    const extras = ['tests.ts', 'README.md', 'generated.ts'];

    return {
        version: '0.3.0', source: { label: 'Call folding regression', sessions: { sessions: [], requirements: [] } },
        files: [file('flow.ts'), ...extras.map(file)],
        results: [
            { hunks: steps.map((s, i) => hunk(i + 1)), manifest, review },
            ...extras.map((path, i) => ({
                hunks: [hunk(null, 1)], manifest: { ...manifest, logic_changes: [] },
                review: { ...review, role: ['test', 'docs', 'source'][i], generated: i === 2 },
            })),
        ],
        cross_file: {
            // A repeated reference has no displayed subtree and must not make a leaf a parent.
            reading_order: [...steps.slice(0, -1), { ...steps[5], depth: 1, repeat: true }, steps.at(-1)],
            moves: [], broken_references: [], signature_impacts: [], test_reach: [],
        },
        concerns: [],
    };
}

test('reading-order call folding in the real viewer', async t => {
    const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'favicon.svg'].map(async name => [name, await readFile(new URL(name, web), 'utf8')])));
    // Keep the test local and deterministic; syntax highlighting is optional in the viewer.
    assets.set('index.html', assets.get('index.html').replace(/<script src="https:[^>]+><\/script>/g, ''));
    const data = JSON.stringify(fixture());
    const server = createServer((req, res) => {
        if (req.url === '/api/diff') { res.setHeader('Content-Type', 'application/json'); res.end(data); return; }
        const name = req.url === '/' ? 'index.html' : req.url.slice(1);
        if (!assets.has(name)) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(assets.get(name));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const session = `fold-calls-${process.pid}`;
    async function browser(...args) {
        const { stdout } = await exec('agent-browser', ['--session', session, '--json', ...args]);
        return JSON.parse(stdout).data;
    }
    async function evaluate(fn) {
        return (await browser('eval', '-b', Buffer.from(`(${fn})()`).toString('base64'))).result;
    }
    t.after(async () => { await browser('close'); await new Promise(resolve => server.close(resolve)); });
    await browser('open', `http://127.0.0.1:${server.address().port}/#view=flow`);
    await browser('wait', '[data-call-toggle]');
    await evaluate(() => {
        window.row = gi => document.querySelector(`.toc-group[data-gi="${gi}"]`);
        window.fold = gi => row(gi).querySelector('[data-call-toggle]').click();
        window.visibleGroups = () => [...document.querySelectorAll('.toc-group[data-gi]')].filter(el => el.getClientRects().length).map(el => +el.dataset.gi);
    });

    await t.test('depth/order, roots, repeated references and leaves', async () => {
        assert.deepEqual(await evaluate(() => groups.map(g => [g.label, g.flowParent ?? null, !!g.flowHasChildren])), [
            ['Types & data', null, false], ['main', null, true], ['parse', 1, true],
            ['tokenize', 2, false], ['save', 1, false], ['standalone', null, false],
            ['main', null, true], ['finish', 6, false], ['Other changed code', null, false],
            ['Tests', null, false], ['Docs', null, false], ['Mechanical changes', null, false],
        ]);
        assert.deepEqual(await evaluate(() => [...document.querySelectorAll('[data-call-toggle]')].map(b => +b.dataset.callToggle)), [1, 2, 6]);
        assert.equal(await evaluate(() => groups[1].flowKey !== groups[6].flowKey), true);
    });

    await t.test('nested folds survive parent folding and routine rerenders', async () => {
        assert.deepEqual(await evaluate(() => { fold(2); fold(1); return visibleGroups(); }), [0, 1, 5, 6, 7, 8, 9, 10, 11]);
        assert.deepEqual(await evaluate(() => { fold(1); return visibleGroups(); }), [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert.equal(await evaluate(() => { renderSidebar(); return row(2).querySelector('button').getAttribute('aria-expanded'); }), 'false');
        assert.deepEqual(await evaluate(() => { setMode('files'); setMode('intent'); setMode('flow'); return visibleGroups(); }), [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert.deepEqual(await evaluate(() => { S.tab = 'changes'; renderSidebar(); S.tab = 'outline'; renderSidebar(); return visibleGroups(); }), [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert.deepEqual(await evaluate(() => { setGroupReviewed(5, true); return visibleGroups(); }), [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert.equal(await evaluate(() => { S.onlyUnviewed = true; applyFilter(''); const hidden = !row(5).getClientRects().length; S.onlyUnviewed = false; applyFilter(''); return hidden; }), true);
    });

    await t.test('search reveals descendants without losing folds', async () => {
        assert.deepEqual(await evaluate(() => { fold(1); document.getElementById('toc-filter').value = 'tokenize'; applyFilter('tokenize'); return visibleGroups(); }), [3]);
        assert.equal(await evaluate(() => row(2).querySelector('button').getAttribute('aria-expanded')), 'true');
        assert.deepEqual(await evaluate(() => { document.getElementById('toc-filter').value = ''; applyFilter(''); return visibleGroups(); }), [0, 1, 5, 6, 7, 8, 9, 10, 11]);
        assert.equal(await evaluate(() => row(2).querySelector('button').getAttribute('aria-expanded')), 'false');
    });

    await t.test('navigation reveals only the necessary ancestors', async () => {
        assert.deepEqual(await evaluate(() => { fold(6); S.currentHunk = 2; navigateChange(1); return visibleGroups(); }), [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11]);
        assert.equal(await evaluate(() => S.currentHunk), 3);
        assert.equal(await evaluate(() => { fold(1); markCurrent(); return row(1).querySelector('.toc-head').classList.contains('current'); }), true);
        assert.equal(await evaluate(() => { jumpToGroup(3, true); return !!row(3).getClientRects().length; }), true);
    });

    await t.test('native keyboard toggle keeps focus; entry folding and label jumps stay separate', async () => {
        await browser('focus', '[data-call-toggle="2"]');
        assert.deepEqual(await evaluate(() => { const b = document.activeElement, css = getComputedStyle(b); return [b.offsetWidth, b.offsetHeight, css.outlineStyle, css.outlineWidth]; }), [24, 24, 'solid', '2px']);
        await browser('press', 'Enter');
        assert.deepEqual(await evaluate(() => [row(3).getClientRects().length > 0, document.activeElement.dataset.callToggle, row(2).querySelector('button').getAttribute('aria-expanded')]), [false, '2', 'false']);
        await browser('press', 'Space');
        assert.equal(await evaluate(() => row(3).getClientRects().length > 0), true);
        assert.deepEqual(await evaluate(() => { const before = row(2).classList.contains('collapsed'); row(2).querySelector('[data-group-toggle]').click(); return [before, row(2).classList.contains('collapsed'), !!row(3).getClientRects().length]; }), [true, false, true]);
        await browser('click', '.toc-group[data-gi="4"] .flow-name');
        await browser('wait', '--fn', 'S.currentHunk === 4');
        assert.equal(await evaluate(() => row(2).querySelector('button').getAttribute('aria-expanded')), 'true');
    });
});
