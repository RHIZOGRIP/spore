// Each package runs under its own config — the setup that points XDG_CONFIG_HOME and the
// admission slots at scratch directories included — however vitest is started.
export default {
  test: {
    projects: ['packages/*', 'plugins/*']
  }
}
