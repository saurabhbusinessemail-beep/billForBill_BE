'use strict';

const supportedCurrencies = Object.freeze(['INR']);
const defaultCurrency = supportedCurrencies[0];

function businessCurrency(business) {
  return supportedCurrencies.includes(business?.currencyCode) ? business.currencyCode : defaultCurrency;
}

module.exports = { businessCurrency, defaultCurrency, supportedCurrencies };
