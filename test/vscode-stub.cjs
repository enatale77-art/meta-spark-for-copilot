/**
 * Minimal `vscode` module stub so pure `src/usage` logic that only needs the
 * module namespace for types can load under plain `node:test`.
 * Only the bare module shape is provided — anything touching real editor
 * behavior must stay out of deterministic tests.
 */
module.exports = {};
