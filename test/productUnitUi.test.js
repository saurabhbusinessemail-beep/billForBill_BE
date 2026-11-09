'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('../../FE/bill_for_bill/node_modules/typescript');
const filename = path.resolve(__dirname, '../../FE/bill_for_bill/src/app/features/documents/unit-conversion.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const mod = new Module(filename, module); mod._compile(compiled, filename);
const { convertLineUnit, scalePrice } = mod.exports;
test('unit switching preserves base quantity and gross price for manual and master prices', () => {
  assert.deepEqual(convertLineUnit('10', '15', '1', '5'), { quantity: '2', unitPrice: '75' });
  assert.deepEqual(convertLineUnit('2', '75', '5', '1'), { quantity: '10', unitPrice: '15' });
  assert.deepEqual(convertLineUnit('1.5', '0.25', '1', '0.001'), { quantity: '1500', unitPrice: '0.00025' });
  assert.equal(scalePrice('8', '5'), '40');
});
test('unit switching rejects nonrepresentable quantities and never rounds to zero', () => {
  assert.throws(() => convertLineUnit('1', '1', '1', '3'));
  assert.throws(() => convertLineUnit('0.000001', '1', '1', '100'));
  assert.throws(() => convertLineUnit('1', '1', '0', '1'));
  assert.throws(() => convertLineUnit('1', '1', '1', '-1'));
  assert.deepEqual(convertLineUnit('1', '0', '1', '5'), { quantity: '0.2', unitPrice: '0' });
});
