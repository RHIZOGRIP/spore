# @rhizogrip/spore-plugin-brave

Web search for spores through the [Brave Search API](https://brave.com/search/api/).

```
npm i -g @rhizogrip/spore-plugin-brave
echo 'BRAVE_API_SK=…' >> ~/.config/spore/environment
spore plugin allow brave
```

A spore uses it once its `spore.cmk` says `plugins: [brave]`. Its agent is given
`$SPORE_BRAVE`, a program that searches and prints the results, and `plugins/brave.md`, which
says how to run it.

The plugin describes the endpoint as a source, `brave`, which spore's runner holds: the
`BRAVE_API_SK` it sends is read from the runner's own environment and never reaches the agent,
nor does the address. A spore using the plugin is granted that source, so a precursor may grant
it to a cell with `sources: [brave]`. Without the key, a turn of such a spore is refused at start
and says which variable is missing.

## License

Apache-2.0
