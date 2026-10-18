import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../slug.mjs';

test('exports-slug', () => assert.equal(typeof slug, 'function'));
test('trim-case', () => assert.equal(slug('  Hello World  '), 'hello-world'));
test('spaces', () => assert.equal(slug('many   spaces'), 'many-spaces'));
test('punctuation', () => assert.equal(slug('Hello, world!'), 'hello-world'));
test('invalid-input', () => assert.throws(() => slug(null), TypeError));
