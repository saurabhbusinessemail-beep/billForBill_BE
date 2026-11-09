'use strict';

const serviceModes = ['date_time', 'dates', 'times', 'one_date', 'one_date_time', 'none'];
const rateSeconds = { day: 86400, hour: 3600, minute: 60, second: 1 };
const rateModes = ['fixed', ...Object.keys(rateSeconds)];
const isSingleService = mode => mode === 'one_date' || mode === 'one_date_time';
const isNonDurationService = mode => mode === 'none' || isSingleService(mode);

function todayInZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts();
  const part = name => parts.find(item => item.type === name).value;
  return [part('year'), part('month'), part('day')].join('-');
}

function measurement(mode, input, timeZone, savedDate) {
  if (mode === 'none') return { mode, timeZone };
  const invalid = () => Object.assign(new Error('Enter valid service dates and times.'), { statusCode: 400, code: 'INVALID_SERVICE_RANGE' });
  const timeOnlyDate = mode === 'times' ? savedDate || todayInZone(timeZone) : null;
  const startDate = timeOnlyDate || input?.startDate;
  const endDate = timeOnlyDate || input?.endDate;
  const startTime = mode === 'dates' ? '00:00' : input?.startTime;
  const endTime = mode === 'dates' ? '00:00' : input?.endTime;
  const instant = (date, time) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) throw invalid();
    const utc = Date.parse(`${date}T${time}Z`);
    if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) throw invalid();
    return utc;
  };
  if (isSingleService(mode)) {
    instant(startDate, mode === 'one_date' ? '00:00' : startTime);
    return { mode, startDate, ...(mode === 'one_date_time' ? { startTime } : {}), timeZone };
  }
  const durationSeconds = (instant(endDate, endTime) - instant(startDate, startTime)) / 1000 + (mode === 'dates' ? rateSeconds.day : 0);
  if (durationSeconds <= 0) throw invalid();
  return { mode, startDate, endDate, startTime, endTime, durationSeconds, timeZone };
}

module.exports = { serviceModes, rateModes, rateSeconds, measurement, isNonDurationService };
