// A dozen suites start real runner and agent processes, which take about a second alone
// and several under a full parallel run beside tests that burn CPU on purpose. Tests that
// guard a deadline of their own set a shorter timeout explicitly.
export default {
  test: {
    testTimeout: 20_000,
    env: { SPORE_TEST_HOST_TURNS: '1' },
    setupFiles: ['./test/fixtures/fresh-native.js', './test/fixtures/own-slots.js', './test/fixtures/own-config.js']
  }
}
