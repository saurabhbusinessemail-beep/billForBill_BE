'use strict';
const { Schema } = require('mongoose');
const unit = new Schema({ key: String, name: String, symbol: String, dimension: String, factorToBase: Schema.Types.Decimal128, conversionKind: String, active: Boolean, source: String, sourceText: String }, { _id: false });
const variant = new Schema({ key: String, label: String, sourceText: String, amountInBase: Schema.Types.Decimal128, contentQuantity: Schema.Types.Decimal128, contentUnit: String, packageCount: Number, amountPerPiece: Schema.Types.Decimal128, amountPerPieceUnit: String, unitKey: String, source: String, active: Boolean }, { _id: false });
module.exports = { baseUnit: { type: unit }, units: { type: [unit], default: undefined }, quantityVariants: { type: [variant], default: undefined } };
