/*
 * Deterministic Math for the game simulation.
 *
 * The browser and the referee server must compute exactly the same physics.
 * +, -, *, / and sqrt give identical results on every JavaScript engine, but
 * Math.sin / Math.cos / Math.pow and friends do not. So the simulation only
 * sees this object: sin and cos are computed here from basic operations, the
 * exact functions pass through, and everything else throws so that a
 * non-deterministic call can never slip in unnoticed.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CAG = root.CAG || {}; root.CAG.detMath = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var M = Math;

  var TWO_OVER_PI = 0.6366197723675814;
  var PIO2_HI = 1.5707963267341256;      // first 33 bits of pi/2
  var PIO2_LO = 6.077100506506192e-11;   // pi/2 - PIO2_HI

  var S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
      S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  var C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
      C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

  function kSin(x) {
    var z = x * x, v = z * x;
    var r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    return x + v * (S1 + z * r);
  }
  function kCos(x) {
    var z = x * x;
    var r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    return 1 - (0.5 * z - z * r);
  }
  // Returns the quadrant (0..3) and leaves the reduced angle in `red`.
  var red = 0;
  function reduce(x) {
    var k = M.round(x * TWO_OVER_PI);
    red = (x - k * PIO2_HI) - k * PIO2_LO;
    var n = k % 4;
    return n < 0 ? n + 4 : n;
  }
  function sin(x) {
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    var n = reduce(x);
    return n === 0 ? kSin(red) : n === 1 ? kCos(red) : n === 2 ? -kSin(red) : -kCos(red);
  }
  function cos(x) {
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    var n = reduce(x);
    return n === 0 ? kCos(red) : n === 1 ? -kSin(red) : n === 2 ? -kCos(red) : kSin(red);
  }

  function banned(name) {
    return function () { throw new Error('Non-deterministic Math.' + name + ' used inside the simulation'); };
  }

  var out = { sin: sin, cos: cos };
  ['abs', 'min', 'max', 'floor', 'ceil', 'round', 'sqrt', 'trunc', 'sign', 'imul'].forEach(function (k) { out[k] = M[k]; });
  ['PI', 'E', 'SQRT2', 'SQRT1_2', 'LN2', 'LN10', 'LOG2E', 'LOG10E'].forEach(function (k) { out[k] = M[k]; });
  ['tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'cbrt', 'hypot',
    'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'random', 'fround', 'clz32'].forEach(function (k) { out[k] = banned(k); });
  return out;
});
