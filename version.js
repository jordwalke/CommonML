exports.number = 10;
exports.ensureAtLeast = function(n) {
  if (exports.number < n) {
    process.exit(1);
  }
  process.exit(0);
};
