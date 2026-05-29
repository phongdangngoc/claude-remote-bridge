import { test } from './_runner.js'
import { strict as assert } from 'assert'
import { escapeHtml } from '../lib/telegram.js'

test('escapeHtml: neutralises the three HTML-reserved characters', () => {
    assert.equal(escapeHtml('a & b < c > d'), 'a &amp; b &lt; c &gt; d')
})

test('escapeHtml: Markdown metachars pass through untouched (safe under parse_mode HTML)', () => {
    // The whole point: labels like these used to break parse_mode 'Markdown'.
    // Under HTML they are literal, so no escaping of * _ ` [ is needed.
    assert.equal(escapeHtml('Edit config_loader.py'), 'Edit config_loader.py')
    assert.equal(escapeHtml('run `npm install` *now*'), 'run `npm install` *now*')
})
