import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { theme, generateHostTokens } from './theme.mjs';

const luminance = hex => {
  const values = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
};
const contrast = (a, b) => { const l = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l[0] + .05) / (l[1] + .05); };

test('shared primary and hover labels retain 4.5:1 contrast in each theme', () => {
  for (const mode of ['light', 'dark']) {
    const colors = theme[mode];
    for (const fill of [colors.primary, colors.primaryHover]) assert.ok(contrast(fill, colors.primaryForeground) >= 4.5, `${mode} primary label`);
    assert.ok(contrast(colors.foreground, colors.background) >= 4.5, `${mode} body`);
    assert.ok(contrast(colors.mutedForeground, colors.card) >= 4.5, `${mode} secondary text`);
    assert.ok(contrast(colors.ring, colors.background) >= 3, `${mode} focus ring`);
    assert.ok(contrast(colors.input, colors.inputBackground) >= 3, `${mode} input boundary`);
  }
});

test('host output is deterministic and exactly matches the versioned shared palette', () => {
  const output = generateHostTokens();
  assert.equal(output, generateHostTokens());
  assert.equal(readFileSync(new URL('../../apps/desktop/src/styles/tokens.css', import.meta.url), 'utf8'), output);
});
