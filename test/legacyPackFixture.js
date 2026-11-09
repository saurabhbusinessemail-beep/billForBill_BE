'use strict';
const units = require('../src/services/productUnits');
const ONE = units.fixed('1');
const packaging = ['Pack', 'package', 1n];
function parseOffQuantity(record = {}) {
  const warnings = []; let duplicateVariants = 0;
  const parse = sourceText => {
    const input = sourceText.trim();
    const text = /^(?:pack|packet|pouch|bottle|can|box)$/i.test(input) ? `1 ${input}` : input;
    const match = /^(?:(\d+)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*([a-z]+)(?:\s+\3)?$/i.exec(text);
    if (!match) return null;
    let symbol = match[3].toLowerCase();
    if (['gm', 'gms'].includes(symbol)) symbol = 'g';
    const packageNames = { pack: 'Pack', packs: 'Pack', packet: 'Packet', packets: 'Packet', pouch: 'Pouch', pouches: 'Pouch', bottle: 'Bottle', bottles: 'Bottle', can: 'Can', cans: 'Can', box: 'Box', boxes: 'Box' };
    const isPack = Object.hasOwn(packageNames, symbol);
    const packageLabel = isPack ? packageNames[symbol] : null;
    const metric = isPack ? packaging : units.metric(symbol);
    if (!metric) return null;
    try { units.fixed(match[2]); } catch { return null; }
    const packageCount = match[1] ? Number(match[1]) : undefined;
    if (packageCount !== undefined && (!Number.isSafeInteger(packageCount) || packageCount < 1)) return null;
    symbol = isPack ? packageLabel.toLowerCase() : Object.keys(units.metrics).find(key => units.metrics[key] === metric);
    return { sourceText, amount: match[2], symbol, metric, packageCount, packageLabel: packageLabel || null };
  };
  const raw = String(record.quantity || '').trim(); let parsed = [];
  if (raw) {
    // Decimal commas with one/two fractional digits are unambiguous here; 1,000 remains ambiguous.
    const decimal = /^(\d+),(\d{1,2})\s*([a-z]+)$/i.exec(raw);
    const source = decimal ? `${decimal[1]}.${decimal[2]} ${decimal[3]}` : raw;
    const segments = source.split(',').map(s => s.trim()); const values = segments.map(parse);
    if (!segments.length || values.some(v => !v)) warnings.push({ sourceText: raw, reason: raw.includes(',') && !decimal ? 'ambiguous_quantity' : 'unsupported_quantity' });
    else parsed = values.map(v => ({ ...v, sourceText: decimal ? raw : v.sourceText }));
  }
  const normalizedSymbol = String(record.product_quantity_unit || '').trim().toLowerCase();
  if (record.product_quantity != null && normalizedSymbol) {
    const pair = parse(`${record.product_quantity} ${normalizedSymbol}`);
    if (pair) parsed.push({ ...pair, normalized: true });
    else warnings.push({ sourceText: String(record.product_quantity), reason: 'unsupported_quantity' });
  } else if (record.product_quantity != null || normalizedSymbol) warnings.push({ sourceText: `${record.product_quantity || ''} ${normalizedSymbol}`.trim(), reason: 'unsupported_quantity' });
  if (!parsed.length) {
    if (!warnings.length) warnings.push({ sourceText: raw, reason: 'missing_quantity' });
    return { ...units.normalize({}, true), warnings, duplicateVariants };
  }
  const first = parsed[0]; const physicalPack = ['mass', 'volume'].includes(first.metric[1]);
  const firstTotal = units.fixed(first.amount) * BigInt(first.packageCount || 1);
  if (physicalPack) {
    try { units.fixed(units.text(firstTotal)); } catch { return { ...units.normalize({}, true), warnings: [...warnings, { sourceText: first.sourceText, reason: 'unsupported_quantity' }], duplicateVariants }; }
  }
  const baseUnit = physicalPack || first.metric[1] === 'package'
    ? { key: 'base', name: physicalPack ? 'Pack' : first.packageLabel || 'Pack', symbol: physicalPack ? 'pack' : first.symbol, dimension: 'package', factorToBase: '1', source: 'open_food_facts' }
    : { key: 'base', name: first.metric[0], symbol: first.symbol, dimension: first.metric[1], factorToBase: '1', source: 'open_food_facts' };
  const choices = []; const quantityVariants = [];
  for (const p of parsed) {
    if (p.metric[1] !== first.metric[1]) { warnings.push({ sourceText: p.sourceText, reason: 'incompatible_dimension' }); continue; }
    const numerator = units.fixed(p.amount) * p.metric[2];
    if (numerator % first.metric[2]) { warnings.push({ sourceText: p.sourceText, reason: 'unsupported_precision' }); continue; }
    const perPiece = numerator / first.metric[2]; const total = perPiece * BigInt(p.packageCount || 1);
    if (physicalPack) { try { units.fixed(units.text(total)); } catch { warnings.push({ sourceText: p.sourceText, reason: 'unsupported_quantity' }); continue; } }
    const anchor = physicalPack ? firstTotal : ONE;
    if ((total * ONE) % anchor) { warnings.push({ sourceText: p.sourceText, reason: 'unsupported_precision' }); continue; }
    const factor = total * ONE / anchor; const amountInBase = units.text(factor);
    try { units.fixed(amountInBase); } catch { warnings.push({ sourceText: p.sourceText, reason: 'unsupported_quantity' }); continue; }
    if (quantityVariants.some(v => v.amountInBase === amountInBase && (p.normalized || v.packageCount === p.packageCount))) { duplicateVariants++; continue; }
    const unitKey = factor === ONE && !quantityVariants.some(v => v.unitKey === 'base') ? 'base' : `size_${quantityVariants.length + 1}`;
    const label = `${p.packageCount ? p.packageCount + ' × ' : ''}${units.text(units.fixed(p.amount))} ${p.symbol}`.slice(0, 100);
    if (unitKey !== 'base') choices.push({ key: unitKey, name: `${physicalPack ? 'Pack' : 'Bundle'} (${label})`.slice(0, 100), symbol: physicalPack ? 'pack' : 'bundle', dimension: baseUnit.dimension, conversionKind: 'product_specific', factorToBase: amountInBase, source: 'open_food_facts', sourceText: p.sourceText, active: true });
    quantityVariants.push({ key: `variant_${quantityVariants.length + 1}`, label, sourceText: p.sourceText, amountInBase, unitKey, source: 'open_food_facts', active: true,
      ...(physicalPack ? { contentQuantity: units.text(total), contentUnit: first.symbol } : {}),
      ...(p.packageCount && first.metric[1] !== 'package' ? { packageCount: p.packageCount, amountPerPiece: p.amount, amountPerPieceUnit: p.symbol } : {}) });
    // Keep a piece option only when its exact pack conversion fits supported precision.
    if (physicalPack && p.packageCount && !choices.some(u => u.dimension === 'count' && units.fixed(u.factorToBase) * anchor === perPiece * ONE)) {
      if ((perPiece * ONE) % anchor) { warnings.push({ sourceText: p.sourceText, reason: 'unsupported_precision' }); continue; }
      choices.push({ key: `piece_${quantityVariants.length}`, name: 'Piece', symbol: 'pc', dimension: 'count', conversionKind: 'product_specific', factorToBase: units.text(perPiece * ONE / anchor), source: 'open_food_facts', sourceText: p.sourceText, active: true });
    }
  }
  return { ...units.normalize({ baseUnit, units: choices, quantityVariants }), warnings, duplicateVariants };
}
module.exports = { parseOffQuantity };
