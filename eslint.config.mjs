/* Undefined-identifier check for this service.
 *
 * WHY IT EXISTS. On Aug 24 2026 a refactor deleted a constant and left one
 * caller alive. `node --check` passed — it only parses — and the process BOOTS
 * fine because the reference only throws inside a request handler. So the
 * deploy went green and every TTS synthesis after it returned
 * "502 Application failed to respond" on Kade's live voice lane.
 *
 * Reproduced deliberately afterwards: with the bug back in place `node --check`
 * still says OK, and this config reports
 *     1821:12  error  'NONVERBAL_TAGS' is not defined  no-undef
 *
 * Run before pushing:  npx eslint --config eslint.config.mjs server.js sounds.js
 */
export default [{
  files: ["**/*.js"],
  languageOptions: {
    ecmaVersion: 2022, sourceType: "commonjs",
    globals: { require:"readonly", module:"writable", process:"readonly", console:"readonly",
               Buffer:"readonly", __dirname:"readonly", setTimeout:"readonly", clearTimeout:"readonly",
               setInterval:"readonly", clearInterval:"readonly", fetch:"readonly", URL:"readonly", URLSearchParams:"readonly",
               AbortController:"readonly", TextEncoder:"readonly", TextDecoder:"readonly",
               structuredClone:"readonly", exports:"writable", global:"readonly", WebSocket:"readonly" }
  },
  rules: { "no-undef": "error" }
}];
