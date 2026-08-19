/**
 * Babel exists ONLY so Jest can load @wolffm/logger, which ships ESM with no
 * CJS build. Node 22.12+ requires that graph natively — this codebase runs
 * fine without Babel — but Jest's CJS runtime intercepts require() with its
 * own registry and cannot. Targeting the running node keeps the transform a
 * near-passthrough for this repo's own CommonJS.
 */
module.exports = {
    presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
};
