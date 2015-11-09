exports.number = 11;
exports.ensureAtLeast = function(n) {
  if (exports.number < n) {
    console.error('!!!!!!!!!!!!!!');
    console.error(
      "Cannot perform build because this version of CommonML " +
      "is too low. Your project has requested a minimum of " + n +
      " but this version is " + exports.number
    );
    console.error('!!!!!!!!!!!!!!');
    process.exit(1);
  }
};
