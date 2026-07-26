'use strict';

function unexpectedDefault() {
  throw new Error('contract test must inject the database operation');
}

module.exports = {
  createAlert: unexpectedDefault,
  resolveAlertByDedupKey: unexpectedDefault,
};
