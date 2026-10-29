# @rhizogrip/spore-plugin-images

Images for spores: [sharp](https://sharp.pixelplumbing.com), importable by the programs an
agent writes.

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```
npm i -g @rhizogrip/spore-plugin-images
spore plugin allow images
```

A spore uses it once its `spore.cmk` says `plugins: [images]`. Its workspace then has
`node_modules/sharp`, which its programs import by name, and `plugins/images.md`, which shows
the agent how. A cell is not given it.

sharp installs libvips and the libraries it is built with as a separate package,
`@img/sharp-libvips-<platform>`, under the LGPL-3.0 among others; it is loaded at run time
and is not part of this package. Its README lists each library and its license.

## License

Apache-2.0
