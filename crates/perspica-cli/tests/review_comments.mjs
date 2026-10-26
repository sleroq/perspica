// Run with: node --test crates/perspica-cli/tests/review_comments.mjs
// Requires agent-browser and Chrome; no npm dependencies or live model calls.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const web = new URL('../web/', import.meta.url);
const oldPath = 'src/old café 工具.ts';
const newPath = 'src/new café 工具.ts';
const unsafeText = '<img src=x onerror="window.commentInjected=true"> & </p><script>window.commentInjected=true</script> — café 工具';

function fixture() {
    const span = (line, text) => ({ start_line: line, end_line: line, start_col: 0, end_col: text.length });
    const context = (oldLine, newLine, text) => ({ kind: 'context', content_old: text, content_new: text, old_span: span(oldLine, text), new_span: span(newLine, text) });
    const removed = (line, text) => ({ kind: 'removed', content_old: text, old_span: span(line, text) });
    const added = (line, text) => ({ kind: 'added', content_new: text, new_span: span(line, text) });
    const changes = [
        context(11, 21, 'function café() {'),
        removed(12, '    const value = 0;'), removed(13, '    return value;'),
        added(22, '    const value = 1;'), added(23, '    audit(value);'), added(24, '    return value;'),
        context(14, 25, '}'),
    ];
    const other = [context(3, 7, 'function other() {'), removed(4, '    return 0;'), added(8, '    return 1;'), context(5, 9, '}')];
    function source(items, side) {
        const lines = Array.from({ length: 30 }, (_, i) => `// ${side} source line ${i + 1}`);
        for (const c of items) if (c[side + '_span']) lines[c[side + '_span'].start_line - 1] = c['content_' + side];
        return lines.join('\n');
    }
    const files = [
        { old_path: oldPath, new_path: newPath, status: 'R', changes },
        { old_path: 'src/other.ts', new_path: 'src/other.ts', status: 'M', changes: other },
    ];
    return {
        version: '0.3.0', source: { label: 'Review comments regression', sessions: { sessions: [], requirements: [] } },
        files: files.map(f => ({ old_path: f.old_path, new_path: f.new_path, status: f.status, old_source: source(f.changes, 'old'), new_source: source(f.changes, 'new'), language: 'TypeScript', binary: false })),
        results: files.map((f, i) => ({
            hunks: [{ old_range: { start: i ? 3 : 11, end: i ? 5 : 14 }, new_range: { start: i ? 7 : 21, end: i ? 9 : 25 }, manifest_refs: [i + 1], changes: f.changes }],
            manifest: {
                renames: [], signature_changes: [], extracted_functions: [], moved_code: [], dependency_changes: [], dead_code: [], formatting_only: [], test_entries: [],
                logic_changes: [{ id: i + 1, name: i ? 'other' : 'café', description: 'body modified', location: { file: f.new_path, line_start: i ? 7 : 21, line_end: i ? 9 : 25, side: 'new' } }],
            },
            review: { changed_lines: i ? 2 : 5, mechanical_lines: 0, parsed: true, generated: false, role: 'source', test_lines: 0 },
        })),
        concerns: [],
    };
}

test('browser-local review comments in the real viewer', async t => {
    const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css', 'favicon.svg'].map(async name => [name, await readFile(new URL(name, web), 'utf8')])));
    // Keep the test local and deterministic; syntax highlighting is optional.
    assets.set('index.html', assets.get('index.html').replace(/<script src="https:[^>]+><\/script>/g, ''));
    let data = fixture();
    const requests = [];
    const server = createServer((req, res) => {
        requests.push([req.method, req.url]);
        if (req.url === '/api/diff') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return; }
        const name = req.url === '/' ? 'index.html' : req.url.slice(1);
        if (!assets.has(name)) { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(assets.get(name));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const session = `review-comments-${process.pid}-${server.address().port}`;
    async function browser(...args) {
        const { stdout } = await exec('agent-browser', ['--session', session, '--json', ...args], { timeout: 15000 });
        return JSON.parse(stdout).data;
    }
    async function evaluate(fn, ...args) {
        return (await browser('eval', '-b', Buffer.from(`(${fn})(...${JSON.stringify(args)})`).toString('base64'))).result;
    }
    const line = (fi, side, n) => `[data-review-file="${fi}"][data-review-side="${side}"][data-review-line="${n}"]`;
    const action = (n, name) => `#comments-list .review-comment:nth-child(${n}) [data-comment-${name}]`;
    async function click(selector) {
        // Keep pointer targets clear of the sticky header and within the viewport.
        await evaluate(selector => document.querySelector(selector).scrollIntoView({ block: 'center', behavior: 'instant' }), selector);
        await browser('click', selector);
    }
    async function shiftClick(selector) {
        // agent-browser's click does not carry modifiers from keydown. Dispatch the
        // actual DOM click contract rather than calling a private selection helper.
        await evaluate(selector => document.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })), selector);
    }
    async function cards() {
        return evaluate(() => [...document.querySelectorAll('#comments-list .review-comment')].map(c => [c.querySelector('.comment-reference').textContent, c.querySelector('p').textContent]));
    }
    async function composer() {
        return evaluate(() => [document.querySelector('#comment-composer label')?.textContent, document.querySelector('#comment-text')?.value, [...document.querySelectorAll('[data-review-file="0"][aria-pressed="true"]')].map(b => [b.dataset.reviewSide, +b.dataset.reviewLine])]);
    }
    async function save(text) {
        await browser('fill', '#comment-text', text);
        await browser('focus', '#comment-text');
        await browser('press', 'Control+Enter');
        assert.equal(await evaluate(() => !!document.getElementById('comment-composer')), false, 'saving closes the composer');
    }
    async function reload() {
        await browser('reload');
        await browser('wait', '#h-0-0');
    }
    t.after(async () => {
        try { await browser('close'); } finally { await new Promise(resolve => server.close(resolve)); }
    });
    await browser('open', `http://127.0.0.1:${server.address().port}/#view=files`);
    await browser('wait', '#h-0-0');
    // Avoid timing dependencies on system animation preferences, without testing motion here.
    await evaluate(() => { localStorage.setItem('perspica:animations', 'false'); });
    await reload();

    await t.test('unified source gutters, empty validation, cancel and safe removed-line creation', async () => {
        assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#h-0-0 [data-review-line]')].map(b => [b.dataset.reviewSide, +b.dataset.reviewLine])), [
            ['old', 11], ['new', 21], ['old', 12], ['old', 13], ['new', 22], ['new', 23], ['new', 24], ['old', 14], ['new', 25],
        ]);
        assert.deepEqual(await evaluate(() => [document.getElementById('comments-btn').textContent, document.getElementById('comments-copy-all').disabled]), ['Comments (0)', true]);
        await click(line(0, 'old', 12));
        assert.deepEqual(await composer(), [`${oldPath}:L12 (old/deleted side)`, '', [['old', 12]]]);
        await browser('fill', '#comment-text', '   \n  ');
        await click('#comment-composer [type="submit"]');
        assert.deepEqual(await evaluate(() => [document.getElementById('comment-error').textContent, document.getElementById('comment-text').getAttribute('aria-invalid'), document.activeElement.id]), ['Write a comment before saving.', 'true', 'comment-text']);
        assert.deepEqual(await cards(), []);
        await click('[data-comment-cancel]');
        assert.deepEqual(await evaluate(() => [!!document.getElementById('comment-composer'), document.querySelectorAll('[aria-pressed="true"][data-review-line]').length, document.activeElement.id]), [false, 0, 'comments-btn']);
        await click(line(0, 'new', 22));
        await browser('fill', '#comment-text', 'Discard this draft');
        await browser('press', 'Escape');
        assert.deepEqual(await cards(), []);
        await click(line(0, 'old', 12));
        await browser('fill', '#comment-text', `  ${unsafeText}  `);
        await browser('press', 'Control+Enter');
        assert.deepEqual(await cards(), [[`${oldPath}:L12 (old/deleted side)`, unsafeText]]);
        assert.deepEqual(await evaluate(() => [document.querySelectorAll('.review-comment img, .review-comment script').length, !!window.commentInjected, document.querySelectorAll('[data-comment-thread="0:0"] .review-comment').length, document.activeElement.id]), [0, false, 1, 'comments-btn']);
        assert.equal(await evaluate(selector => document.querySelector(selector).classList.contains('has-comment'), line(0, 'old', 12)), true);
        assert.equal(await evaluate(selector => document.querySelector(selector).classList.contains('has-comment'), line(0, 'new', 22)), false);
    });

    await t.test('reverse Shift-click range keeps its file, side and draft through split rerender', async () => {
        await click(line(0, 'new', 25));
        await browser('fill', '#comment-text', 'Check the new range.');
        assert.deepEqual(await evaluate(() => {
            // Exercise another section finishing lazy rendering while the user types.
            document.querySelector('#s-f1 .section-body').dataset.pending = '1';
            renderSectionBody(document.getElementById('s-f1'));
            const afterLazy = [document.activeElement.id, document.getElementById('comment-text').value];
            renderMain(true);
            return [afterLazy, [document.activeElement.id, document.getElementById('comment-text').value]];
        }), [['comment-text', 'Check the new range.'], ['comment-text', 'Check the new range.']]);
        await shiftClick(line(0, 'new', 22));
        const expected = [`${newPath}:L22-L25`, 'Check the new range.', [['new', 22], ['new', 23], ['new', 24], ['new', 25]]];
        assert.deepEqual(await composer(), expected);
        await shiftClick(line(0, 'old', 13));
        assert.deepEqual(await composer(), expected, 'Shift-click must not cross old/new sides');
        await shiftClick(line(1, 'new', 7));
        assert.deepEqual(await composer(), expected, 'Shift-click must not cross files');
        assert.equal(await evaluate(() => [...document.querySelectorAll('.toast')].some(el => el.textContent.includes('same file and on the same side'))), true);
        await click(line(0, 'new', 21));
        assert.deepEqual(await composer(), expected, 'a plain click cannot silently replace an unsaved draft');
        await click('#view-btn');
        await click('[data-view="split"]');
        assert.deepEqual(await composer(), expected);
        assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#h-0-0 > .row')].map(r => [...r.querySelectorAll('[data-review-line]')].map(b => [b.dataset.reviewSide, +b.dataset.reviewLine]))), [
            [['old', 11], ['new', 21]], [['old', 12], ['new', 22]], [['old', 13], ['new', 23]], [['new', 24]], [['old', 14], ['new', 25]],
        ]);
        await click('#comment-composer [type="submit"]');
        assert.equal((await cards()).length, 2);
        await click(line(0, 'old', 14));
        await shiftClick(line(0, 'old', 11));
        assert.deepEqual(await composer(), [`${oldPath}:L11-L14 (old/deleted side)`, '', [['old', 11], ['old', 12], ['old', 13], ['old', 14]]]);
        await save('Keep the old-side context.');
        await click('#view-btn');
        await click('[data-view="unified"]');
        assert.equal(await evaluate(() => document.querySelectorAll('#h-0-0 .has-comment').length), 8);
    });

    const editedText = `Edited: ${unsafeText}`;
    const expectedCards = [
        [`${oldPath}:L12 (old/deleted side)`, editedText],
        [`${newPath}:L22-L25`, 'Check the new range.'],
        [`${oldPath}:L11-L14 (old/deleted side)`, 'Keep the old-side context.'],
    ];
    await t.test('editing, cancelling an edit, and deleting update both thread and global list', async () => {
        await click('#comments-btn');
        const id = await evaluate(() => document.querySelector('#comments-list [data-comment-edit]').dataset.commentEdit);
        await click(action(1, 'edit'));
        assert.equal((await composer())[1], unsafeText);
        await browser('fill', '#comment-text', 'Do not save this edit');
        await click('[data-comment-cancel]');
        assert.equal((await cards())[0][1], unsafeText);
        await click(action(1, 'edit'));
        await save(editedText);
        assert.deepEqual(await cards(), expectedCards);
        assert.equal(await evaluate(() => document.querySelector('#comments-list [data-comment-edit]').dataset.commentEdit), id, 'editing replaces rather than duplicates the saved comment');
        await click(line(0, 'new', 21));
        await save('Temporary context-line comment');
        assert.equal((await cards()).length, 4);
        assert.equal(await evaluate(selector => document.querySelector(selector).classList.contains('has-comment'), line(0, 'new', 21)), true);
        await click(action(4, 'delete'));
        assert.deepEqual(await cards(), expectedCards);
        assert.deepEqual(await evaluate(selector => [document.querySelector(selector).classList.contains('has-comment'), document.querySelectorAll('[data-comment-thread="0:0"] .review-comment').length, document.getElementById('comments-btn').textContent, document.querySelectorAll('.review-comment img, .review-comment script').length], line(0, 'new', 21)), [false, 3, 'Comments (3)', 0]);
        assert.deepEqual(await evaluate(() => S.data), data, 'comments must not be inserted into the diff/model payload');
    });

    const prompt = cards => 'Please address these review comments:\n\n' + cards.map(([ref, text]) => `${ref}\n${text}`).join('\n\n');
    await t.test('clipboard success exports exact individual/all prompts; failure exposes selectable comments', async () => {
        await evaluate(() => {
            window.copiedPrompts = [];
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedPrompts.push(text); } } });
        });
        for (let n = 1; n <= 3; n++) await click(action(n, 'copy'));
        await click('#comments-copy-all');
        assert.equal(await evaluate(() => window.copiedPrompts.length), 4);
        assert.deepEqual(await evaluate(() => window.copiedPrompts), [...expectedCards.map(c => prompt([c])), prompt(expectedCards)]);
        assert.equal(await evaluate(() => [...document.querySelectorAll('.toast')].some(el => el.textContent.includes('Review prompt copied.'))), true);
        await evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied by test'); }; });
        await click('#comments-btn');
        assert.equal(await evaluate(() => document.getElementById('comments-panel').classList.contains('hidden')), true);
        await click('[data-comment-thread="0:0"] [data-comment-copy]');
        await browser('wait', '--fn', '!document.getElementById("comments-panel").classList.contains("hidden")');
        assert.equal(await evaluate(() => [...document.querySelectorAll('.toast.error')].some(el => el.textContent.includes('Could not copy. Select and copy the comments below instead.'))), true);
        assert.equal(await evaluate(() => document.getElementById('comments-btn').getAttribute('aria-expanded')), 'true');
        assert.deepEqual(await cards(), expectedCards);
        await browser('press', 'Escape');
        assert.deepEqual(await evaluate(() => [document.getElementById('comments-panel').classList.contains('hidden'), document.getElementById('comments-btn').getAttribute('aria-expanded')]), [true, 'false']);
        await click('#comments-btn');
    });

    await t.test('saved comments remain discoverable and exportable with all source files folded', async () => {
        await click('#comments-btn');
        for (let fi = 0; fi < 2; fi++) await click(`#s-f${fi} [data-section-toggle]`);
        assert.equal(await evaluate(() => [...document.querySelectorAll('#diff-scroll .review-comment')].every(c => !c.getClientRects().length)), true);
        await click('#comments-btn');
        assert.deepEqual(await cards(), expectedCards);
        assert.deepEqual(await evaluate(() => [document.getElementById('comments-btn').textContent, document.getElementById('comments-btn').getAttribute('aria-expanded'), [...document.querySelectorAll('#comments-list .review-comment')].every(c => !!c.getClientRects().length)]), ['Comments (3)', 'true', true]);
        await click(action(1, 'edit'));
        assert.deepEqual(await evaluate(() => [document.getElementById('comment-composer').parentElement.id, !!document.getElementById('comment-text').getClientRects().length, document.activeElement.id, document.getElementById('comment-text').value]), ['comment-home', true, 'comment-text', editedText]);
        await browser('press', 'Escape');
        assert.deepEqual(await cards(), expectedCards);
        await evaluate(() => { navigator.clipboard.writeText = async text => { window.copiedPrompts.push(text); }; });
        await click('#comments-copy-all');
        assert.equal(await evaluate(() => window.copiedPrompts.length), 5);
        assert.equal(await evaluate(() => window.copiedPrompts.at(-1)), prompt(expectedCards));
    });

    await t.test('reload persistence is scoped to the exact sources and source spans', async () => {
        await reload();
        assert.deepEqual(await cards(), expectedCards);
        assert.equal(await evaluate(() => document.querySelectorAll('[data-comment-thread="0:0"] .review-comment').length), 3);
        assert.equal(await evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('perspica:comments:')).length), 1);
        // Only a source-span column changes: same source, paths, ranges and changed text.
        data = fixture();
        data.results[0].hunks[0].changes[1].old_span.start_col = 1;
        await reload();
        assert.deepEqual(await cards(), [], 'identical changed text with different spans must not inherit notes');
        assert.deepEqual(await evaluate(() => [document.getElementById('comments-copy-all').disabled, document.querySelectorAll('.has-comment').length]), [true, 0]);
        await click(line(0, 'new', 22));
        await save('Only for the changed-span review');
        assert.equal((await cards()).length, 1);
        data = fixture();
        data.files[1].new_source += '\n// A change outside the displayed hunk';
        await reload();
        assert.deepEqual(await cards(), [], 'a different full source must not inherit either review’s notes');
        data = fixture();
        await reload();
        assert.deepEqual(await cards(), expectedCards, 'returning to the exact original diff restores its own notes');
        assert.deepEqual(await evaluate(() => S.data), data);
        assert.equal(requests.every(([method, url]) => method === 'GET' && (url === '/api/diff' || url === '/' || assets.has(url.slice(1)))), true, 'comment operations must never send notes to an API');
    });
});
